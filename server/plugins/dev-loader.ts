// Dev-mode plugin loading via `--dev-plugin <path>` CLI flag (PR2 of #1159).
//
// Unlike production plugins (which extract from a tgz under
// `~/mulmoclaude/plugins/` into a versioned cache), dev plugins are
// served straight from the author's project directory. The flow is:
//
//   1. Launcher parses `--dev-plugin` CLI flags, resolves each to an
//      absolute path, and joins them into `MULMOCLAUDE_DEV_PLUGINS`
//      using `path.delimiter`.
//   2. Server reads the env var, splits, and validates each path
//      structurally (directory, package.json, dist/index.js).
//   3. Server loads each via the existing `loadPluginFromCacheDir`
//      with `version="dev"` so the asset URL is
//      `/api/plugins/runtime/<pkg>/dev/...`.
//   4. Caller (server/index.ts boot path) detects collisions against
//      both prod-installed plugins and other dev plugins; on any
//      collision, logs all involved abs paths and `process.exit(1)`.
//
// The module exports the helpers — not a single mega-function — so
// the boot path can decide when to exit and tests can drive each
// step independently.

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadPluginFromCacheDir, type LoaderDeps, type RuntimePlugin } from "./runtime-loader.js";
import { log } from "../system/logger/index.js";
import { isRecord } from "../utils/types.js";

const LOG_PREFIX = "plugins/dev";

/** Sentinel version stamped on every dev-loaded plugin. Visible in
 *  the registry and the asset URL — picking a non-semver string makes
 *  it obvious in `/api/plugins/runtime/list` that this is a dev load,
 *  and avoids fake "wins by being newer" semver comparisons. */
export const DEV_VERSION = "dev";

export interface DevPluginInput {
  /** What the user typed on the CLI (relative or absolute). */
  rawInput: string;
  /** Resolved absolute path to the plugin project root. */
  absPath: string;
}

export type DevPluginValidation = { ok: true; name: string } | { ok: false; reason: string };

export interface DevPluginCollision {
  name: string;
  /** Sources that share this name. Mix of abs paths (dev plugins)
   *  and "(installed) <cachePath>" strings (prod plugins). Logged
   *  verbatim so the dev can identify each candidate. */
  sources: string[];
}

export interface LoadDevPluginsResult {
  plugins: RuntimePlugin[];
  /** Per-input failure messages, in the order the inputs appeared.
   *  Caller decides whether to continue or exit. */
  errors: string[];
}

/** Split `MULMOCLAUDE_DEV_PLUGINS` into resolved inputs. Empty / absent
 *  env returns []. Relative paths are resolved against `cwd` (so tests
 *  can drive this without needing the launcher's pre-resolution). */
export function parseDevPluginsEnv(value: string | undefined, cwd: string): DevPluginInput[] {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .filter((segment) => segment.length > 0)
    .map((rawInput) => ({ rawInput, absPath: path.resolve(cwd, rawInput) }));
}

/** Structural check on a candidate dev-plugin directory. Returns the
 *  package name on success so the caller doesn't have to re-parse
 *  package.json. Errors name the resolved abs path, not the user's
 *  input — the dev needs to know what mulmoclaude actually probed. */
export async function validateDevPluginPath(absPath: string): Promise<DevPluginValidation> {
  if (!existsSync(absPath)) return { ok: false, reason: `path does not exist: ${absPath}` };
  if (!statSync(absPath).isDirectory()) return { ok: false, reason: `path is not a directory: ${absPath}` };
  const pkgPath = path.join(absPath, "package.json");
  if (!existsSync(pkgPath)) return { ok: false, reason: `package.json not found at: ${pkgPath}` };
  let name: unknown;
  try {
    const raw = await readFile(pkgPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    name = isRecord(parsed) ? parsed.name : undefined;
  } catch (err) {
    return { ok: false, reason: `package.json unreadable at ${pkgPath}: ${String(err)}` };
  }
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, reason: `package.json has no "name" field: ${pkgPath}` };
  }
  const distEntry = path.join(absPath, "dist", "index.js");
  if (!existsSync(distEntry)) {
    return { ok: false, reason: `dist/index.js not found at ${distEntry} — did you run \`yarn build\` (or \`yarn dev\`)?` };
  }
  return { ok: true, name };
}

/** Load every dev-plugin input. Never throws — returns errors as
 *  strings so the boot path can collect all of them and exit with a
 *  clear list, rather than failing on the first one. */
export async function loadDevPlugins(inputs: readonly DevPluginInput[], deps: LoaderDeps = {}): Promise<LoadDevPluginsResult> {
  const plugins: RuntimePlugin[] = [];
  const errors: string[] = [];
  for (const input of inputs) {
    const validation = await validateDevPluginPath(input.absPath);
    if (!validation.ok) {
      errors.push(`${input.rawInput}: ${validation.reason}`);
      log.error(LOG_PREFIX, "invalid dev plugin", { input: input.rawInput, abs: input.absPath, reason: validation.reason });
      continue;
    }
    const plugin = await loadPluginFromCacheDir(validation.name, DEV_VERSION, input.absPath, deps);
    if (!plugin) {
      errors.push(`${input.rawInput}: failed to load ${validation.name} from ${input.absPath} (see prior log)`);
      continue;
    }
    log.info(LOG_PREFIX, "loaded dev plugin", { name: plugin.name, abs: input.absPath });
    plugins.push(plugin);
  }
  return { plugins, errors };
}

/** Boot-time gate verdict. The server's plugin-init IIFE composes
 *  loadDevPlugins + detectDevCollisions to decide whether to abort
 *  startup. Splitting the verdict out as a pure function keeps the
 *  hard-exit policy testable without spawning a server process. */
export type DevPluginGate = { ok: true; plugins: readonly RuntimePlugin[] } | { ok: false; fatalMessages: readonly string[] };

/** Compose `loadDevPlugins` + `detectDevCollisions` into a single
 *  pass/fail verdict. The caller (server/index.ts) logs each
 *  fatalMessage and `process.exit(1)`s; tests assert on the verdict
 *  shape directly. */
export function evaluateDevPluginGate(devLoad: LoadDevPluginsResult, otherPlugins: readonly RuntimePlugin[]): DevPluginGate {
  // The caller logs each message under the `plugins/dev` category, so
  // the structured logger already prepends `[plugins/dev]`. Don't bake
  // the prefix into the message strings — that would print it twice.
  if (devLoad.errors.length > 0) {
    const messages = [...devLoad.errors, `${devLoad.errors.length} dev plugin(s) failed to load — refusing to start.`];
    return { ok: false, fatalMessages: messages };
  }
  const collisions = detectDevCollisions(devLoad.plugins, otherPlugins);
  if (collisions.length > 0) {
    const messages = collisions.map((collision) => `name collision: ${collision.name} sources=${JSON.stringify(collision.sources)}`);
    messages.push("dev plugin name collides with installed plugin or another dev plugin — refusing to start.");
    return { ok: false, fatalMessages: messages };
  }
  return { ok: true, plugins: devLoad.plugins };
}

/** Detect name collisions: within the dev set, and across dev↔prod.
 *  Returns one entry per collided name; sources lists every cachePath
 *  involved. Empty when clean. */
export function detectDevCollisions(devPlugins: readonly RuntimePlugin[], prodPlugins: readonly RuntimePlugin[]): DevPluginCollision[] {
  const devByName = new Map<string, RuntimePlugin[]>();
  for (const plugin of devPlugins) {
    const list = devByName.get(plugin.name) ?? [];
    list.push(plugin);
    devByName.set(plugin.name, list);
  }
  const prodByName = new Map(prodPlugins.map((plugin) => [plugin.name, plugin]));
  const collisions: DevPluginCollision[] = [];
  for (const [name, devGroup] of devByName) {
    const prod = prodByName.get(name);
    if (devGroup.length === 1 && !prod) continue;
    const sources: string[] = devGroup.map((plugin) => plugin.cachePath);
    if (prod) sources.push(`(installed) ${prod.cachePath}`);
    collisions.push({ name, sources });
  }
  return collisions;
}
