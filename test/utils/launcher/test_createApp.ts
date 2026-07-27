// Tests for `server/utils/launcher/macos/create-app.mjs` — the app
// bundle generator. Bundle layout is asserted rather than eyeballed
// because a missing file only shows up as an icon that does nothing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppBundle, renderInfoPlist, renderNodeMissingText } from "../../../server/utils/launcher/macos/create-app.mjs";
import { LAUNCHER_LOCALES, launcherMessages } from "../../../server/utils/launcher/messages.mjs";

describe("renderInfoPlist", () => {
  const plist = renderInfoPlist({ name: "MulmoClaude", version: "1.7.1" });

  it("names the executable and icon the bundle actually ships", () => {
    assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>launch<\/string>/);
    assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>icon<\/string>/);
  });

  it("carries the version it was given", () => {
    assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.7\.1<\/string>/);
  });

  it("escapes XML so a stray character cannot produce an unreadable plist", () => {
    assert.match(renderInfoPlist({ name: "A & B", version: "1.0.0" }), /<string>A &amp; B<\/string>/);
  });
});

describe("renderNodeMissingText", () => {
  it("puts the title on line 1 and starts the body on line 2 — the stub splits on exactly that", () => {
    LAUNCHER_LOCALES.forEach((locale) => {
      const [title, second] = renderNodeMissingText(locale).split("\n");
      assert.equal(title, launcherMessages(locale).nodeMissing.title, locale);
      assert.ok(second.length > 0, `${locale}: blank second line would open the alert with an empty paragraph`);
    });
  });

  it("keeps the download URL in the text, since a native alert cannot render a link", () => {
    LAUNCHER_LOCALES.forEach((locale) => {
      assert.match(renderNodeMissingText(locale), /https:\/\/nodejs\.org\//, locale);
    });
  });
});

describe("createAppBundle", () => {
  it("writes a launchable bundle with every runtime file the stub imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mulmoclaude-bundle-"));
    const bundlePath = join(dir, "MulmoClaude.app");
    try {
      await createAppBundle({ bundlePath, name: "MulmoClaude", version: "9.9.9" });

      const expected = [
        "Contents/Info.plist",
        "Contents/MacOS/launch",
        "Contents/Resources/utils/launcher/run.mjs",
        "Contents/Resources/utils/launcher/start.mjs",
        "Contents/Resources/utils/launcher/detect-server.mjs",
        "Contents/Resources/utils/launcher/launcher-page.mjs",
        "Contents/Resources/utils/launcher/messages.mjs",
        "Contents/Resources/utils/launcher/preflight.mjs",
        "Contents/Resources/utils/launcher/macos/resolve-path.sh",
        "Contents/Resources/utils/launcher/macos/message-file.sh",
        // start.mjs imports `../port.mjs`; the bundle mirrors the repo
        // layout so that relative import still resolves.
        "Contents/Resources/utils/port.mjs",
      ];
      expected.forEach((relative) => assert.ok(existsSync(join(bundlePath, relative)), `missing ${relative}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not ship the generator itself — it imports sharp, which the bundle cannot resolve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mulmoclaude-bundle-"));
    const bundlePath = join(dir, "MulmoClaude.app");
    try {
      await createAppBundle({ bundlePath, name: "MulmoClaude", version: "9.9.9" });
      ["create-app.mjs", "icon.mjs", "create-shortcut.mjs"].forEach((name) => {
        assert.ok(!existsSync(join(bundlePath, "Contents/Resources/utils/launcher/macos", name)), `${name} leaked into the bundle`);
        assert.ok(!existsSync(join(bundlePath, "Contents/Resources/utils/launcher", name)), `${name} leaked into the bundle`);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a message file for every locale plus a plain `pt` the stub can match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mulmoclaude-bundle-"));
    const bundlePath = join(dir, "MulmoClaude.app");
    try {
      await createAppBundle({ bundlePath, name: "MulmoClaude", version: "9.9.9" });
      const messagesDir = join(bundlePath, "Contents/Resources/messages");
      LAUNCHER_LOCALES.forEach((locale) => assert.ok(existsSync(join(messagesDir, `${locale}.txt`)), locale));
      // The stub looks up `ja` from `ja_JP`, so `pt_BR` needs a `pt`.
      assert.ok(existsSync(join(messagesDir, "pt.txt")));
      assert.equal(readFileSync(join(messagesDir, "pt.txt"), "utf8"), readFileSync(join(messagesDir, "pt-BR.txt"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces an existing bundle instead of merging into it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mulmoclaude-bundle-"));
    const bundlePath = join(dir, "MulmoClaude.app");
    try {
      await createAppBundle({ bundlePath, name: "MulmoClaude", version: "1.0.0" });
      await createAppBundle({ bundlePath, name: "MulmoClaude", version: "2.0.0" });
      const plist = readFileSync(join(bundlePath, "Contents/Info.plist"), "utf8");
      assert.match(plist, /<string>2\.0\.0<\/string>/);
      assert.ok(!plist.includes("1.0.0"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks the stub executable — a bundle whose binary is not +x cannot launch", { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "mulmoclaude-bundle-"));
    const bundlePath = join(dir, "MulmoClaude.app");
    try {
      await createAppBundle({ bundlePath, name: "MulmoClaude", version: "9.9.9" });
      const { mode } = statSync(join(bundlePath, "Contents/MacOS/launch"));
      assert.equal(mode & 0o111, 0o111, "executable bit missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
