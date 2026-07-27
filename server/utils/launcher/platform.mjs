// The few places the shared launcher has to know which OS it is on.
//
// PR1's plan drew the line deliberately: prerequisite order, messages,
// server detection and the pages stay in ONE implementation, and only
// (a) PATH recovery (b) how the artifact is produced (c) the native
// dialog are written per OS. These two argv builders are what keeps
// that line intact — without them `start.mjs` would have to fork, and
// the check order and wording would drift apart on each side.
//
// Pure on purpose: they decide a command line or a path and nothing
// else, so both platforms' answers are pinned by tests that run on
// either OS.

import { homedir } from "node:os";
import { join } from "node:path";

const APP_DIR_NAME = "MulmoClaude";

/**
 * `%LOCALAPPDATA%` with the conventional fallback. Local rather than
 * roaming on purpose: these are machine-specific paths and caches, and
 * a roaming profile would carry them to a machine where they mean
 * nothing.
 * @param {{ home?: string, env?: Record<string, string | undefined> }} [deps]
 * @returns {string}
 */
export function windowsLocalAppData({ home = homedir(), env = process.env } = {}) {
  return env.LOCALAPPDATA?.trim() ? env.LOCALAPPDATA : join(home, "AppData", "Local");
}

/**
 * Where the launcher writes its log and the progress page it opens.
 *
 * macOS conventions (`~/Library/Logs`, `~/Library/Caches`) were the only
 * ones here until Windows arrived; left alone they would have created a
 * literal `Library\Logs` folder in the Windows user profile, which is
 * both wrong and invisible to anyone looking for a log.
 * @param {{ home?: string, platform?: string, env?: Record<string, string | undefined> }} [deps]
 * @returns {{ logPath: string, pageDir: string }}
 */
export function launcherPaths({ home = homedir(), platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    const root = join(windowsLocalAppData({ home, env }), APP_DIR_NAME);
    return { logPath: join(root, "logs", "launcher.log"), pageDir: join(root, "cache") };
  }
  return {
    logPath: join(home, "Library", "Logs", APP_DIR_NAME, "launcher.log"),
    pageDir: join(home, "Library", "Caches", APP_DIR_NAME),
  };
}

/**
 * A `file:` URL for a local path.
 *
 * `file://` + the path is right on POSIX and wrong on Windows: a drive
 * path has to become `file:///C:/Users/...`, and the backslashes have to
 * turn into forward slashes first. Left unconverted the browser reads
 * `C:` as the HOST, so the link silently opens nothing — on the error
 * page, whose whole job is to hand the user their log.
 * @param {string} path
 * @param {string} [platform]
 * @returns {string}
 */
export function fileUrl(path, platform = process.platform) {
  if (platform !== "win32") return `file://${encodeURI(path)}`;
  // A UNC path (\\server\share) keeps its host: `file://server/share`.
  if (path.startsWith(String.raw`\\`)) return `file://${encodeURI(path.slice(2).replace(/\\/g, "/"))}`;
  return `file:///${encodeURI(path.replace(/\\/g, "/").replace(/^\/+/, ""))}`;
}

/**
 * How to hand a file path or URL to the user's browser.
 *
 * `start` is a cmd builtin, not an executable, hence the `cmd /c`. Its
 * first quoted argument is taken as the window TITLE, so the empty
 * string is load-bearing: without it a quoted path (the usual case —
 * the progress page lives under a temp dir) would be swallowed as a
 * title and nothing would open.
 * @param {string} target
 * @param {string} platform
 * @returns {{ command: string, args: string[] }}
 */
export function browserOpenArgv(target, platform) {
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "cmd.exe", args: ["/c", "start", "", target] };
  return { command: "xdg-open", args: [target] };
}

/**
 * `npx` on Windows is `npx.cmd`, a batch file. Node's spawn without a
 * shell resolves executables only, so the bare name fails with ENOENT
 * — and because the server is spawned DETACHED, nothing would surface
 * that failure: the progress page would simply spin until it timed out.
 * @param {string} platform
 * @returns {string}
 */
export function npxCommand(platform) {
  return platform === "win32" ? "npx.cmd" : "npx";
}
