// Paths the `yarn dev` file watcher must not react to (#2632).
//
// Pure: no imports, no I/O. Every path is supplied already resolved so the
// predicate stays unit-testable across platforms from any CI host.
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
// workspace IS the Vite root. `config/` is absent on purpose: it is a tracked
// repo directory here as well as a workspace dir, and it is not a storm driver.
const WORKSPACE_RUNTIME_ENTRIES = ["conversations", "data", "artifacts", "feeds", ".mulmoclaude", ".session-token", ".server-port"] as const;

const toPosix = (filePath: string): string => filePath.replace(/\\/g, "/").replace(/\/+$/, "");

const isInside = (candidate: string, directory: string): boolean => candidate === directory || candidate.startsWith(`${directory}/`);

const workspacePrefixes = (projectRoot: string, workspacePath: string): string[] => {
  if (workspacePath === projectRoot) return WORKSPACE_RUNTIME_ENTRIES.map((entry) => `${projectRoot}/${entry}`);
  return isInside(workspacePath, projectRoot) ? [workspacePath] : [];
};

/** Absolute, posix-normalised directories pruned from the dev watcher. */
export const devWatchIgnoredPrefixes = (options: DevWatchIgnoreOptions): string[] => {
  const projectRoot = toPosix(options.projectRoot);
  return [`${projectRoot}/server/system/logs`, ...workspacePrefixes(projectRoot, toPosix(options.workspacePath))];
};

// Segment-wise so `packages/foo/src/dist-utils.ts` is left alone.
const isPackageDist = (candidate: string, projectRoot: string): boolean => {
  const packagesRoot = `${projectRoot}/packages/`;
  if (!candidate.startsWith(packagesRoot)) return false;
  return candidate.slice(packagesRoot.length).split("/").includes("dist");
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
