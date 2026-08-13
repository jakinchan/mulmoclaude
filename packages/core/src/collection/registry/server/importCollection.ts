// Import-side fetch + transform helpers for a registry collection. The writer
// (writes into .claude/skills/, materializes seed, records provenance) builds on
// these; kept separate so the pure, security-critical parts are unit-tested.
//
// Files to fetch come from the collection's manifest.json (published by the
// registry's build-index). Every manifest path is re-checked for safety here —
// the host must never write outside the target skill dir even if the manifest is
// malformed/poisoned.

import { isUnknownArray } from "@mulmoclaude/common";
import { isRecord } from "../guards.js";
import { fetchCollectionFile, parseJsonObject, rawBaseForEntry } from "./collectionFiles.js";
import type { RegistryEntry } from "../registryIndex.js";
import type { RegistryScope } from "./registriesConfig.js";

const MANIFEST_FILE = "manifest.json";
const STATUS_BAD_GATEWAY = 502;

/** A manifest entry must be a relative path that stays inside the collection dir:
 *  no absolute paths, no backslashes, no empty / `.` / `..` segments. */
export function isSafeBundlePath(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.startsWith("/") || rel.includes("\\")) return false;
  return !rel.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export type ManifestResult = { ok: true; files: string[] } | { ok: false; error: string };

/** A rejected entry, rendered for the error message. A string prints as itself —
 *  the overwhelmingly common case, and what this always used to print. Anything
 *  else goes through JSON so a poisoned manifest shows its actual value rather
 *  than `[object Object]`.
 *
 *  Never throws. `JSON.stringify` does — on a circular object, on a `bigint` —
 *  and this function only ever runs on the REJECTION path, so a throw here
 *  would turn a `{ ok: false }` the caller can handle into an exception it
 *  cannot. `Object.prototype.toString` is the one renderer with no user code
 *  in it. */
const showUnsafe = (entry: unknown): string => {
  if (typeof entry === "string") return entry;
  try {
    // `?? String(entry)`: JSON renders undefined / a function / a symbol as
    // the value `undefined`, and those still deserve a name in the message.
    return JSON.stringify(entry) ?? String(entry);
  } catch {
    return Object.prototype.toString.call(entry);
  }
};

export function parseManifest(value: unknown): ManifestResult {
  // `isUnknownArray`, not `Array.isArray`: the latter narrows `unknown` to
  // `any[]`, so every element read below would be `any`. The elements stay
  // `unknown` until `isSafeBundlePath`, a type predicate, narrows them.
  const files = isRecord(value) ? value.files : undefined;
  if (!isUnknownArray(files)) return { ok: false, error: "manifest is missing a files[] array" };
  // `findIndex`, not `find`: `find` answers `undefined` both for "nothing
  // unsafe" and for "the unsafe entry IS `undefined`", so an `undefined` (or a
  // hole) read as a clean manifest and `filter` then dropped it silently.
  const unsafeIndex = files.findIndex((file) => !isSafeBundlePath(file));
  if (unsafeIndex !== -1) return { ok: false, error: `manifest contains an unsafe path: ${showUnsafe(files[unsafeIndex])}` };
  return { ok: true, files: files.filter(isSafeBundlePath) };
}

/** `data/collections/<localSlug>/items` — the host owns dataPath, never the
 *  registry's authored value, so imported collections can't collide on disk. */
export function normalizedDataPath(localSlug: string): string {
  return `data/collections/${localSlug}/items`;
}

export function withNormalizedDataPath(schema: Record<string, unknown>, localSlug: string): Record<string, unknown> {
  return { ...schema, dataPath: normalizedDataPath(localSlug) };
}

export type ManifestFetch = { ok: true; files: string[] } | { ok: false; status: number; error: string };

export async function fetchManifest(entry: RegistryEntry, scope: RegistryScope = {}): Promise<ManifestFetch> {
  const rawBase = rawBaseForEntry(entry, scope);
  if (!rawBase) return { ok: false, status: STATUS_BAD_GATEWAY, error: `registry "${entry.registryName}" is no longer configured` };
  const file = await fetchCollectionFile(rawBase, entry.path, MANIFEST_FILE);
  if (!file.ok) return { ok: false, status: file.status, error: `manifest.json: ${file.error}` };
  const obj = parseJsonObject(file.text, "manifest.json");
  if (!obj.ok) return { ok: false, status: STATUS_BAD_GATEWAY, error: obj.error };
  const manifest = parseManifest(obj.value);
  if (!manifest.ok) return { ok: false, status: STATUS_BAD_GATEWAY, error: manifest.error };
  return { ok: true, files: manifest.files };
}

export type BundleFetch = { ok: true; files: Map<string, string> } | { ok: false; status: number; error: string };

/** Fetch every manifest file. Paths are already safety-checked by parseManifest. */
export async function fetchBundle(entry: RegistryEntry, fileList: readonly string[], scope: RegistryScope = {}): Promise<BundleFetch> {
  const rawBase = rawBaseForEntry(entry, scope);
  if (!rawBase) return { ok: false, status: STATUS_BAD_GATEWAY, error: `registry "${entry.registryName}" is no longer configured` };
  const files = new Map<string, string>();
  for (const rel of fileList) {
    const file = await fetchCollectionFile(rawBase, entry.path, rel);
    if (!file.ok) return { ok: false, status: file.status, error: `${rel}: ${file.error}` };
    files.set(rel, file.text);
  }
  return { ok: true, files };
}
