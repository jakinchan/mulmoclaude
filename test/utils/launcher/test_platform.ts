// Tests for `server/utils/launcher/platform.mjs`.
//
// Both of these decide a command line that only ever runs on the OS the
// developer is not using, and both fail SILENTLY when wrong: the server
// is spawned detached, so a bad `npx` name surfaces as a progress page
// that spins until it times out, and a bad browser command surfaces as
// nothing happening at all.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserOpenArgv, launcherPaths, npxCommand, windowsLocalAppData } from "../../../server/utils/launcher/platform.mjs";
import { join } from "node:path";

describe("browserOpenArgv", () => {
  it("uses each platform's opener", () => {
    assert.deepEqual(browserOpenArgv("/tmp/progress.html", "darwin"), { command: "open", args: ["/tmp/progress.html"] });
    assert.deepEqual(browserOpenArgv("http://localhost:3001", "linux"), { command: "xdg-open", args: ["http://localhost:3001"] });
  });

  it("keeps the empty title argument on Windows", () => {
    // `start` reads its first quoted argument as the window title. The
    // progress page lives under a temp dir whose path is quoted, so
    // without the empty title it would be consumed as one and nothing
    // would open.
    const { command, args } = browserOpenArgv(String.raw`C:\Users\a b\progress.html`, "win32");
    assert.equal(command, "cmd.exe");
    assert.deepEqual(args, ["/c", "start", "", String.raw`C:\Users\a b\progress.html`]);
  });

  it("passes the target through untouched on every platform", () => {
    const target = String.raw`C:\Users\a b\progress.html?x=1&y=2`;
    (["darwin", "win32", "linux"] as const).forEach((platform) => {
      const { args } = browserOpenArgv(target, platform);
      assert.ok(args.includes(target), platform);
    });
  });
});

describe("npxCommand", () => {
  it("asks for npx.cmd on Windows — spawn without a shell cannot run a bare batch name", () => {
    assert.equal(npxCommand("win32"), "npx.cmd");
  });

  it("stays npx everywhere else", () => {
    assert.equal(npxCommand("darwin"), "npx");
    assert.equal(npxCommand("linux"), "npx");
  });
});

describe("launcherPaths", () => {
  const home = String.raw`C:\Users\a`;

  it("keeps the macOS conventions on darwin", () => {
    const { logPath, pageDir } = launcherPaths({ home: "/Users/a", platform: "darwin", env: {} });
    assert.equal(logPath, "/Users/a/Library/Logs/MulmoClaude/launcher.log");
    assert.equal(pageDir, "/Users/a/Library/Caches/MulmoClaude");
  });

  it("uses LOCALAPPDATA on Windows rather than inventing a Library folder", () => {
    // Left unported, the macOS path would create a literal `Library\Logs`
    // in the Windows profile — the launcher tells the user where its log
    // is, so it would be pointing at a folder no Windows user expects.
    const { logPath, pageDir } = launcherPaths({ home, platform: "win32", env: { LOCALAPPDATA: String.raw`C:\Users\a\AppData\Local` } });
    assert.equal(logPath, join(String.raw`C:\Users\a\AppData\Local`, "MulmoClaude", "logs", "launcher.log"));
    assert.equal(pageDir, join(String.raw`C:\Users\a\AppData\Local`, "MulmoClaude", "cache"));
  });

  it("falls back to the conventional location when LOCALAPPDATA is absent", () => {
    assert.equal(windowsLocalAppData({ home, env: {} }), join(home, "AppData", "Local"));
    assert.equal(windowsLocalAppData({ home, env: { LOCALAPPDATA: "  " } }), join(home, "AppData", "Local"));
  });
});
