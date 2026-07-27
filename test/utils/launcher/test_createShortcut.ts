// Tests for `server/utils/launcher/create-shortcut.mjs` — argument
// handling and where the bundle lands.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { join } from "node:path";

import { defaultInstallDir, parseCreateShortcutArgs, resolveBundlePath } from "../../../server/utils/launcher/create-shortcut.mjs";

describe("parseCreateShortcutArgs", () => {
  it("defaults to no directory and no assumed yes", () => {
    assert.deepEqual(parseCreateShortcutArgs([]), { ok: true, dir: null, assumeYes: false });
  });

  it("reads --dir and both spellings of yes", () => {
    assert.deepEqual(parseCreateShortcutArgs(["--dir", "/tmp/apps"]), { ok: true, dir: "/tmp/apps", assumeYes: false });
    assert.deepEqual(parseCreateShortcutArgs(["--dir", "/tmp/apps", "--yes"]), { ok: true, dir: "/tmp/apps", assumeYes: true });
    assert.deepEqual(parseCreateShortcutArgs(["-y"]), { ok: true, dir: null, assumeYes: true });
  });

  it("rejects --dir with no value instead of silently using none", () => {
    const parsed = parseCreateShortcutArgs(["--dir"]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.reason : "", /--dir requires a directory path/);
  });

  it("rejects --dir followed by another flag — otherwise it creates a literal '--yes' directory", () => {
    const parsed = parseCreateShortcutArgs(["--dir", "--yes"]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.reason : "", /--yes/);
  });

  it("rejects an empty or blank --dir, which would otherwise reach mkdirSync('') and throw ENOENT", () => {
    ["", "   ", "\t"].forEach((value) => {
      const parsed = parseCreateShortcutArgs(["--dir", value]);
      assert.equal(parsed.ok, false, `expected ${JSON.stringify(value)} to be rejected`);
    });
  });
});

describe("defaultInstallDir", () => {
  it("uses /Applications when it is writable", () => {
    assert.equal(defaultInstallDir({ home: "/Users/example", canWrite: () => true }), "/Applications");
  });

  it("falls back to ~/Applications rather than failing for a non-admin account", () => {
    assert.equal(defaultInstallDir({ home: "/Users/example", canWrite: () => false }), "/Users/example/Applications");
  });
});

describe("resolveBundlePath", () => {
  it("puts the bundle inside an explicit --dir", () => {
    assert.deepEqual(resolveBundlePath("/tmp/apps"), { installDir: "/tmp/apps", bundlePath: "/tmp/apps/MulmoClaude.app" });
  });

  it("falls back to the default install dir when none was given", () => {
    const { installDir, bundlePath } = resolveBundlePath(null);
    assert.ok(installDir.endsWith("Applications"), installDir);
    assert.equal(bundlePath, join(installDir, "MulmoClaude.app"));
  });
});
