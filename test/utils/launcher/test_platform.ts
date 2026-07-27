// Tests for `server/utils/launcher/platform.mjs`.
//
// Both of these decide a command line that only ever runs on the OS the
// developer is not using, and both fail SILENTLY when wrong: the server
// is spawned detached, so a bad `npx` name surfaces as a progress page
// that spins until it times out, and a bad browser command surfaces as
// nothing happening at all.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { browserOpenArgv, npxCommand } from "../../../server/utils/launcher/platform.mjs";

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
