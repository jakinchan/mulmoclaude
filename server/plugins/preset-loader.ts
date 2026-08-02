// Preset plugin loader (#1043 C-2 follow-up).
//
// Reads `server/plugins/preset-list.ts` at boot and resolves each
// entry against the package's installed location via Node's standard
// module-resolution (`import.meta.resolve`). The package is already
// laid out by `npm install` / `yarn install`; no tgz unpack step.
// The result is the same `RuntimePlugin` shape user-installed plugins
// produce, so both flows share the runtime registry, the dispatch
// route, and the asset route.
//
// Why not a hardcoded `node_modules/<pkg>` join: yarn workspaces
// hoist deps to the repo root, so the launcher sees the package in
// `<repo>/node_modules/...` while `<repo>/packages/mulmoclaude/node_modules/`
// is empty. `import.meta.resolve` walks the same way Node does at
// runtime, so it finds the package wherever the package manager put
// it. (npm's flat install doesn't have this issue — it lands under
// `<package>/node_modules/...` directly. Both work with the same
// resolver call.)
//
// Trust model: the package name comes from the server-side hardcoded
// preset list, not from user input. We trust the resolved path
// without an `ensureInsideBase` anchor because there is no base —
// the resolver returns wherever the package manager chose. The asset
// route's `realpathSync(plugin.cachePath)` still pins to whatever was
// resolved here at registration time; a route caller cannot redirect
// to a different path via URL params.
//
// Failures don't abort boot. A missing preset (install drift, rare)
// logs a warning; healthy presets still register.

import { readFileSync } from "node:fs";
import path from "node:path";
import { PRESET_PLUGINS, type PresetPlugin } from "./preset-list.js";
// The preset-package resolver lives in its own module so the sandbox
// regression probe (test/sandbox-repro/probe.ts) can import it inside a
// node:22-slim container without dragging in the full server graph
// (logger, plugin registry). Re-exported so existing imports of
// `resolvePresetRoot` from this file keep working.
import { resolvePresetRoot } from "./resolvePresetRoot.js";
import { loadPluginFromCacheDir, type LoaderDeps, type RuntimePlugin } from "./runtime-loader.js";
import { log } from "../system/logger/index.js";
import { isRecord } from "../utils/types.js";

export { resolvePresetRoot };

const LOG_PREFIX = "plugins/preset";

/** The preset's declared version, or null when the package.json is
 *  unreadable / malformed / versionless — a broken preset is skipped, never
 *  fatal. */
function readPresetVersion(pkgJsonPath: string, packageName: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    const version = isRecord(parsed) ? parsed.version : undefined;
    if (typeof version !== "string" || version.length === 0) {
      log.warn(LOG_PREFIX, "preset package has no version", { packageName });
      return null;
    }
    return version;
  } catch (err) {
    log.warn(LOG_PREFIX, "preset package.json read/parse failed", { packageName, error: String(err) });
    return null;
  }
}

async function loadOnePreset(entry: PresetPlugin, deps: LoaderDeps = {}): Promise<RuntimePlugin | null> {
  const { packageName, devOnly } = entry;
  const cachePath = resolvePresetRoot(packageName);
  if (!cachePath) {
    // dev-only entries are knowingly absent from the published tarball;
    // surfacing them as warn would mislead `npx mulmoclaude` users.
    if (devOnly) {
      log.debug(LOG_PREFIX, "dev-only preset not present (expected on a published install)", { packageName });
    } else {
      log.warn(LOG_PREFIX, "preset package not resolvable — run `yarn install`?", { packageName });
    }
    return null;
  }
  const version = readPresetVersion(path.join(cachePath, "package.json"), packageName);
  if (version === null) return null;
  return loadPluginFromCacheDir(packageName, version, cachePath, deps);
}

/** Load every preset declared in `server/plugins/preset-list.ts`.
 *  Returns the loaded set; failures are logged and silently
 *  skipped.
 *
 *  Pass `deps.runtimeFactory` from the parent server so factory-shape
 *  presets get a real runtime; the MCP child can omit it (definition-
 *  only). */
export async function loadPresetPlugins(deps: LoaderDeps = {}): Promise<RuntimePlugin[]> {
  if (PRESET_PLUGINS.length === 0) return [];
  const loaded: RuntimePlugin[] = [];
  for (const entry of PRESET_PLUGINS) {
    const plugin = await loadOnePreset(entry, deps);
    if (plugin) loaded.push(plugin);
  }
  log.info(LOG_PREFIX, "loaded", { requested: PRESET_PLUGINS.length, succeeded: loaded.length });
  return loaded;
}
