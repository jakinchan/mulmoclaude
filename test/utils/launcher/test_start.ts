// Tests for the decisions in `server/utils/launcher/start.mjs` that can
// be checked without actually launching anything.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { launcherLogPath, serverSpawnPlan } from "../../../server/utils/launcher/start.mjs";

describe("serverSpawnPlan", () => {
  it("asks npx for the latest release on the chosen port, without opening a browser", () => {
    const { command, args } = serverSpawnPlan({ port: 3005, platform: "darwin" });
    assert.equal(command, "npx");
    assert.deepEqual(args, ["mulmoclaude@latest", "--port", "3005", "--no-open"]);
  });

  it("asks for npx.cmd on Windows — spawn cannot resolve a bare batch name", () => {
    // The server is spawned DETACHED, so an ENOENT here surfaces as a
    // progress page spinning until it times out, never as an error.
    assert.equal(serverSpawnPlan({ port: 3005, platform: "win32" }).command, "npx.cmd");
  });

  it("passes --no-open — the progress page does the navigating, so the CLI must not open a second tab", () => {
    assert.ok(serverSpawnPlan({ port: 3001 }).args.includes("--no-open"));
  });

  it("runs from home, never the `/` a GUI launch inherits", () => {
    // The CLI reads `<cwd>/.env`. With the inherited cwd that is `/.env`,
    // which the user cannot write — the documented way to supply
    // GEMINI_API_KEY would quietly do nothing from the icon.
    assert.equal(serverSpawnPlan({ port: 3001, home: "/Users/example" }).cwd, "/Users/example");
    assert.equal(serverSpawnPlan({ port: 3001 }).cwd, homedir());
    assert.notEqual(serverSpawnPlan({ port: 3001 }).cwd, "/");
  });
});

describe("launcherLogPath", () => {
  it("uses the per-app location Console.app also looks at", () => {
    // Platform passed explicitly: the answer is per-OS since #2623, so
    // leaving it to the host would assert macOS behaviour on the Windows
    // runner and fail for a reason the code is not responsible for.
    assert.equal(launcherLogPath("/Users/example", "darwin"), join("/Users/example", "Library", "Logs", "MulmoClaude", "launcher.log"));
  });

  it("uses LOCALAPPDATA on Windows, not a Library folder that means nothing there", () => {
    const windowsLog = launcherLogPath(String.raw`C:\Users\example`, "win32");
    assert.match(windowsLog, /MulmoClaude/);
    assert.doesNotMatch(windowsLog, /Library/);
  });
});
