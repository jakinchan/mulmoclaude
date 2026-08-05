// The host-neutral per-user config file shared by MulmoClaude and
// MulmoTerminal (`~/.config/mulmo/config.json`, `@mulmoclaude/core/global-config`).
//
// The file is hand-edited — there is no UI that writes it — so the rule under
// test is tolerance: every unusable value must read as "not configured" (null),
// letting the caller apply its own default, rather than throwing or handing a
// broken regex source on to a browser that will compile it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import {
  MAX_BOOKMARK_PATTERN_LENGTH,
  loadDocumentBookmarkPattern,
  mulmoConfigDir,
  mulmoGlobalConfigPath,
  readDocumentBookmarkPattern,
} from "@mulmoclaude/core/global-config";

describe("mulmoGlobalConfigPath", () => {
  it("resolves under the host-neutral ~/.config/mulmo directory", () => {
    assert.equal(mulmoConfigDir("/home/tester"), path.join("/home/tester", ".config", "mulmo"));
    assert.equal(mulmoGlobalConfigPath("/home/tester"), path.join("/home/tester", ".config", "mulmo", "config.json"));
  });
});

describe("readDocumentBookmarkPattern", () => {
  it("reads a configured pattern", () => {
    assert.equal(readDocumentBookmarkPattern({ documentBookmarks: { pattern: "^\\.\\.\\." } }), "^\\.\\.\\.");
  });

  for (const [label, config] of [
    ["a missing file (null)", null],
    ["a non-object document", "nope"],
    ["a missing documentBookmarks key", { other: 1 }],
    ["a non-object documentBookmarks", { documentBookmarks: "^x" }],
    ["a missing pattern key", { documentBookmarks: {} }],
    ["a non-string pattern", { documentBookmarks: { pattern: 42 } }],
    ["an empty pattern", { documentBookmarks: { pattern: "" } }],
    ["a pattern that does not compile", { documentBookmarks: { pattern: "^([a-z" } }],
  ] as const) {
    it(`returns null for ${label}`, () => {
      assert.equal(readDocumentBookmarkPattern(config), null);
    });
  }

  it("rejects a pattern longer than the length cap", () => {
    const tooLong = `^${"a".repeat(MAX_BOOKMARK_PATTERN_LENGTH)}`;
    assert.equal(readDocumentBookmarkPattern({ documentBookmarks: { pattern: tooLong } }), null);
    const atCap = `^${"a".repeat(MAX_BOOKMARK_PATTERN_LENGTH - 1)}`;
    assert.equal(readDocumentBookmarkPattern({ documentBookmarks: { pattern: atCap } }), atCap);
  });
});

describe("loadDocumentBookmarkPattern", () => {
  const withFakeHome = async (write: ((dir: string) => Promise<void>) | null, assertion: (home: string) => Promise<void>) => {
    const home = await mkdtemp(path.join(tmpdir(), "mulmo-global-config-"));
    try {
      if (write) {
        const dir = mulmoConfigDir(home);
        await mkdir(dir, { recursive: true });
        await write(dir);
      }
      await assertion(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };

  it("reads the pattern off disk", async () => {
    await withFakeHome(
      (dir) => writeFile(path.join(dir, "config.json"), JSON.stringify({ documentBookmarks: { pattern: "^TODO" } })),
      async (home) => assert.equal(await loadDocumentBookmarkPattern(home), "^TODO"),
    );
  });

  it("returns null when the file does not exist", async () => {
    await withFakeHome(null, async (home) => assert.equal(await loadDocumentBookmarkPattern(home), null));
  });

  it("returns null — rather than throwing — when the file is not valid JSON", async () => {
    await withFakeHome(
      (dir) => writeFile(path.join(dir, "config.json"), "{ this is not json"),
      async (home) => assert.equal(await loadDocumentBookmarkPattern(home), null),
    );
  });
});
