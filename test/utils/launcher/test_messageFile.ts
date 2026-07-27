// Tests for `server/utils/launcher/macos/message-file.sh`.
//
// The shell stub picks the "Node.js is missing" alert text on its own —
// node is by definition absent on that path, so `pickLauncherLocale`
// cannot be asked. That leaves two implementations of one rule, and the
// interesting property is that they never disagree: every case here
// asserts the file the shell picks holds exactly the text the Node half
// would have rendered for the same tag.
//
// Plain POSIX sh with no macOS-only binaries, so it runs on every CI OS.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pickLauncherLocale } from "../../../server/utils/launcher/messages.mjs";
import { writeBundleMessages } from "../../../server/utils/launcher/macos/create-app.mjs";
import { renderNodeMissingText } from "../../../server/utils/launcher/node-missing-text.mjs";

const SCRIPT = join(process.cwd(), "server", "utils", "launcher", "macos", "message-file.sh");

// The locale reaches the shell as an environment value rather than being
// interpolated into the command string, so no tag this test feeds in can
// alter the command's shape.
const pickFile = (messagesDir: string, rawLocale: string): string =>
  execFileSync("/bin/sh", ["-c", '. "$MC_SCRIPT"\nmc_message_file "$MC_DIR" "$MC_LOCALE"'], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", MC_SCRIPT: SCRIPT, MC_DIR: messagesDir, MC_LOCALE: rawLocale },
  }).trim();

const withMessagesDir = (body: (messagesDir: string) => void) => {
  const resources = mkdtempSync(join(tmpdir(), "mulmoclaude-messages-"));
  try {
    writeBundleMessages(resources);
    body(join(resources, "messages"));
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
};

describe("message-file.sh", () => {
  it("resolves the tags macOS actually reports for AppleLocale", () => {
    withMessagesDir((dir) => {
      const cases: [string, string][] = [
        ["en_US", "en.txt"],
        ["ja_JP", "ja.txt"],
        // Script-tagged: a Simplified Chinese system with a US region.
        // Cutting at the `_` alone left `zh-Hans`, which ships no file.
        ["zh-Hans_US", "zh.txt"],
        ["zh_Hans_CN", "zh.txt"],
        ["zh-Hant_TW", "zh.txt"],
        // The one locale shipped only as a regional variant.
        ["pt_BR", "pt-BR.txt"],
        ["pt_PT", "pt.txt"],
        ["ko_KR", "ko.txt"],
        ["fr_FR", "fr.txt"],
        ["de_DE", "de.txt"],
        ["es_ES", "es.txt"],
      ];
      cases.forEach(([rawLocale, expected]) => assert.equal(pickFile(dir, rawLocale), join(dir, expected), rawLocale));
    });
  });

  it("picks the same text the Node half would have rendered", () => {
    withMessagesDir((dir) => {
      const tags = ["en_US", "ja_JP", "ja", "zh-Hans_US", "zh_Hans_CN", "pt_BR", "pt", "pt_PT", "ko_KR", "fr_FR", "de_DE", "es_ES", "kl_GL", ""];
      tags.forEach((rawLocale) => {
        const chosen = readFileSync(pickFile(dir, rawLocale), "utf8");
        assert.equal(chosen, renderNodeMissingText(pickLauncherLocale(rawLocale)), rawLocale);
      });
    });
  });

  it("falls back to English for an unknown or empty tag", () => {
    withMessagesDir((dir) => {
      ["kl_GL", "sw", "", "   "].forEach((rawLocale) => assert.equal(pickFile(dir, rawLocale), join(dir, "en.txt"), rawLocale));
    });
  });

  it("refuses a tag that is not a plain language tag", () => {
    withMessagesDir((dir) => {
      // AppleLocale becomes a path component, so a traversal attempt has
      // to land on English rather than on some other file's first line.
      ["../../etc/passwd", "../messages/ja", "ja/../../en", "ja;ls"].forEach((rawLocale) =>
        assert.equal(pickFile(dir, rawLocale), join(dir, "en.txt"), rawLocale),
      );
    });
  });
});
