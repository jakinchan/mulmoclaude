// Paths the `yarn dev` file watcher must not react to (#2632).
//
// Every path is supplied already resolved, and comparison happens in a
// posix-normalised string space, so the predicate is unit-testable for every
// platform from any CI host. `path.posix` rather than `path` for the same
// reason: a native `path.join` would emit backslashes on Windows and stop
// matching the normalised candidate.
//
// Two independent reload classes reach Vite's watcher:
//
// 1. The workspace lives inside the Vite root. `MULMOCLAUDE_WORKSPACE_PATH`
//    defaults to `~/mulmoclaude`, so cloning the repo there makes the runtime
//    workspace BE the watch root. Chat appends / scheduler ticks / artifact
//    writes then land in it, and `@tailwindcss/vite`'s `hotUpdate` broadcasts a
//    bare `{"type":"full-reload"}` for every scanned-file change.
//
// 2. win32 only. Each sandboxed agent spawn bind-mounts every workspace package
//    read-only into the container (`workspaceModuleMounts`, #1946) and Docker
//    Desktop for Windows bumps the mounted files' mtimes. `packages/*/dist` is
//    in the client module graph — yarn symlinks resolve `@mulmobridge/protocol`
//    there — and has no HMR accept boundary, so an mtime-only bump full-reloads
//    the page.

import path from "node:path";

export interface DevWatchIgnoreOptions {
  /** Vite root, realpath-resolved. */
  projectRoot: string;
  /** Runtime workspace root, realpath-resolved. */
  workspacePath: string;
  platform: NodeJS.Platform;
  /** Keep `packages/*\/dist` watched on Windows, for a dev iterating on a workspace package. */
  watchPackageDists?: boolean;
}

// Top-level workspace entries that only ever hold runtime data, used when the
// workspace IS the Vite root. `config` and `.claude` are absent on purpose:
// both are tracked repo directories here as well as workspace dirs, so pruning
// them would stop HMR for real source. `test/scripts/test_devWatchIgnore.ts`
// fails if a new top-level workspace dir appears without a decision here.
const WORKSPACE_RUNTIME_ENTRIES = [
  "conversations",
  "data",
  "artifacts",
  "feeds",
  "archive",
  "github",
  "models",
  "plugins",
  ".mulmoclaude",
  ".session-token",
  ".server-port",
] as const;

const SERVER_LOG_DIR = ["server", "system", "logs"] as const;

const toPosix = (filePath: string): string => filePath.replace(/\\/g, "/").replace(/\/+$/, "");

const isInside = (candidate: string, directory: string): boolean => candidate === directory || candidate.startsWith(`${directory}/`);

const workspacePrefixes = (projectRoot: string, workspacePath: string): string[] => {
  if (workspacePath === projectRoot) return WORKSPACE_RUNTIME_ENTRIES.map((entry) => path.posix.join(projectRoot, entry));
  return isInside(workspacePath, projectRoot) ? [workspacePath] : [];
};

/** Absolute, posix-normalised directories pruned from the dev watcher. */
export const devWatchIgnoredPrefixes = (options: DevWatchIgnoreOptions): string[] => {
  const projectRoot = toPosix(options.projectRoot);
  return [path.posix.join(projectRoot, ...SERVER_LOG_DIR), ...workspacePrefixes(projectRoot, toPosix(options.workspacePath))];
};

// Segment-wise so `packages/foo/src/dist-utils.ts` is left alone.
const isPackageDist = (candidate: string, projectRoot: string): boolean => {
  const packagesRoot = path.posix.join(projectRoot, "packages");
  if (!isInside(candidate, packagesRoot)) return false;
  return candidate
    .slice(packagesRoot.length + 1)
    .split("/")
    .includes("dist");
};

/** Predicate for Vite's `server.watch.ignored` (anymatch-compatible). */
export const createDevWatchIgnore = (options: DevWatchIgnoreOptions): ((candidate: string) => boolean) => {
  const projectRoot = toPosix(options.projectRoot);
  const prefixes = devWatchIgnoredPrefixes(options);
  const prunePackageDists = options.platform === "win32" && !options.watchPackageDists;
  return (candidate: string): boolean => {
    const normalized = toPosix(candidate);
    if (prefixes.some((prefix) => isInside(normalized, prefix))) return true;
    return prunePackageDists && isPackageDist(normalized, projectRoot);
  };
};
