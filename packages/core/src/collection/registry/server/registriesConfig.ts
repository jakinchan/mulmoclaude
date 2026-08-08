// User-supplied list of extra collection registries (`config/collections-registries.json`).
// The official receptron/mulmoclaude-collections registry is always loaded; this
// file adds more on top so a community / org / private registry shows up in the
// same Discover catalog.
//
// Shape on disk:
//   [
//     { "name": "myorg", "indexUrl": "https://...", "rawBaseUrl": "https://..." }
//   ]
//
// Validation rules (a bad entry is dropped + logged; the rest still load):
//   - `name` matches `[A-Za-z0-9][A-Za-z0-9_-]{0,31}` and is NOT the reserved
//     `official` (which is always synthesized by client.ts)
//   - Both URLs are HTTPS, parseable, and have no userinfo/credentials
//   - Names are unique (later duplicates are dropped, first wins)
//
// Pure read + parse — no network. Caller invalidates by re-reading the file.

import { readFileSync } from "node:fs";

import { isRecord } from "../guards.js";
import { OFFICIAL_REGISTRY_NAME, type RegistryConfigEntry } from "../types.js";
import { collectionsRegistriesConfigPath, getWorkspaceRoot, log } from "../../server/host.js";

/** Which workspace a registry read is scoped to. Omitted ⇒ the host's
 *  configured root (and, under an explicit-root binding, a loud throw rather
 *  than a silent read of another project's config). */
export interface RegistryScope {
  workspaceRoot?: string | undefined;
}

export { OFFICIAL_REGISTRY_NAME, type RegistryConfigEntry };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function isValidHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return true;
}

function parseEntry(value: unknown, index: number): RegistryConfigEntry | string {
  if (!isRecord(value)) return `entry[${index}] is not an object`;
  const { name, indexUrl, rawBaseUrl } = value;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return `entry[${index}].name must match ${NAME_RE.source}`;
  }
  if (name === OFFICIAL_REGISTRY_NAME) {
    return `entry[${index}].name "${OFFICIAL_REGISTRY_NAME}" is reserved`;
  }
  if (!isValidHttpsUrl(indexUrl)) return `entry[${index}].indexUrl must be a valid HTTPS URL (no credentials)`;
  if (!isValidHttpsUrl(rawBaseUrl)) return `entry[${index}].rawBaseUrl must be a valid HTTPS URL (no credentials)`;
  // `rawBaseUrl` gets joined as `${rawBaseUrl}/<path>` downstream — a query or
  // fragment would land in the middle of the composed URL and break every
  // collection-file fetch on that registry (CodeRabbit review on #1837). The
  // index URL is fetched directly so a query is fine there; only rawBase
  // needs the constraint.
  if (rawBaseUrl.includes("?") || rawBaseUrl.includes("#")) {
    return `entry[${index}].rawBaseUrl must not contain a query (?) or fragment (#) — it's joined as a path prefix`;
  }
  // Strip trailing slashes so `${rawBaseUrl}/${path}` joins cleanly regardless
  // of what the user wrote. Plain-loop trim instead of a regex — the linter
  // flags any unanchored-quantifier regex as ReDoS-suspect even when it's
  // safe, and the loop is just as clear at this size.
  let normalizedRawBase = rawBaseUrl;
  while (normalizedRawBase.endsWith("/")) normalizedRawBase = normalizedRawBase.slice(0, -1);
  return { name, indexUrl, rawBaseUrl: normalizedRawBase };
}

/** Parse the JSON text of `config/collections-registries.json`. Bad entries
 *  drop with a warning; valid entries are returned in source order. Exported
 *  for unit testing — the I/O wrapper `loadRegistriesConfig` below reads the
 *  workspace file and delegates here. */
export function parseRegistriesConfig(raw: unknown): RegistryConfigEntry[] {
  if (!Array.isArray(raw)) {
    log.warn("collections-registry", "registries config is not an array — ignoring");
    return [];
  }
  const seen = new Set<string>();
  const out: RegistryConfigEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseEntry(raw[i], i);
    if (typeof parsed === "string") {
      log.warn("collections-registry", "registry config entry rejected", { reason: parsed });
      continue;
    }
    if (seen.has(parsed.name)) {
      log.warn("collections-registry", "registry config duplicate name dropped", { name: parsed.name });
      continue;
    }
    seen.add(parsed.name);
    out.push(parsed);
  }
  return out;
}

// Missing file ⇒ null (the most common case — most users only want the official
// registry). Other read errors propagate, matching the host's prior behavior.
function readConfigTextOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    if (isRecord(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

/** Read `config/collections-registries.json` for a workspace. `workspaceRoot`
 *  defaults to the host's configured root; a multi-root host passes the project
 *  it is serving. Missing file ⇒ empty list. Malformed JSON or rejected entries
 *  log but never throw. */
export function loadRegistriesConfig(opts: RegistryScope = {}): RegistryConfigEntry[] {
  const text = readConfigTextOrNull(collectionsRegistriesConfigPath(opts.workspaceRoot ?? getWorkspaceRoot()));
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn("collections-registry", "registries config is not valid JSON — ignoring", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  return parseRegistriesConfig(parsed);
}
