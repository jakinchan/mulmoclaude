// The few places the shared launcher has to know which OS it is on.
//
// PR1's plan drew the line deliberately: prerequisite order, messages,
// server detection and the pages stay in ONE implementation, and only
// (a) PATH recovery (b) how the artifact is produced (c) the native
// dialog are written per OS. These two argv builders are what keeps
// that line intact — without them `start.mjs` would have to fork, and
// the check order and wording would drift apart on each side.
//
// Pure on purpose: they decide a command line and nothing else, so
// both platforms' answers are pinned by tests that run on either OS.

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
