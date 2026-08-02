import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFaqEntries, entryHasPointer, helpsAssetDir } from "@mulmoclaude/core/workspace-setup";
import { APP_SETTINGS_KEYS } from "../../server/system/config.js";

// Guards the SHIPPED bug-report FAQ (`config/helps/bug-report-faq.md` once
// seeded). The file's whole premise is that it names WHERE to check rather than
// what a value is, because a stale value misleads silently while a stale key or
// path can be detected. This test is what makes that premise true: a config key
// that no longer exists, or a source file that moved, fails here instead of
// sending a confused user to a dead pointer months from now.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FAQ_FILENAME = "bug-report-faq.md";
const HELPS_DIR = helpsAssetDir();
const FAQ_PATH = path.join(HELPS_DIR, FAQ_FILENAME);

const entries = parseFaqEntries(readFileSync(FAQ_PATH, "utf-8"));

// `voiceInput.enabled` is a legal pointer: the root is what has to exist, the
// nested field is prose detail the agent reads in the settings file.
const rootKey = (configKey: string): string => configKey.split(".")[0] ?? configKey;

describe("bundled bug-report FAQ", () => {
  it("ships and parses into entries", () => {
    assert.ok(existsSync(FAQ_PATH), `${FAQ_FILENAME} must ship in ${HELPS_DIR}`);
    assert.ok(entries.length > 0, "FAQ has no entries — the parser or the file changed shape");
  });

  it("gives every entry at least one pointer", () => {
    const unverifiable = entries.filter((entry) => !entryHasPointer(entry)).map((entry) => entry.symptom);
    assert.deepEqual(unverifiable, [], "entries with no configKey / source / help cannot be checked against the running system");
  });

  it("names only config keys that exist in AppSettings", () => {
    const known = new Set<string>(APP_SETTINGS_KEYS);
    const unknown = entries.flatMap((entry) => entry.configKeys.filter((key) => !known.has(rootKey(key))).map((key) => `${entry.symptom} → ${key}`));
    assert.deepEqual(unknown, [], "unknown config key — it was renamed or removed; update the FAQ entry");
  });

  it("names only source paths that exist in the repo", () => {
    const missing = entries.flatMap((entry) => entry.sources.filter((rel) => !existsSync(path.join(REPO_ROOT, rel))).map((rel) => `${entry.symptom} → ${rel}`));
    assert.deepEqual(missing, [], "source path moved — update the FAQ entry to the new location");
  });

  it("names only help pages that ship alongside it", () => {
    const missing = entries.flatMap((entry) =>
      entry.helps.filter((name) => !existsSync(path.join(HELPS_DIR, name))).map((name) => `${entry.symptom} → ${name}`),
    );
    assert.deepEqual(missing, [], "help page missing — a user following this pointer would find nothing");
  });

  it("states no default values in its entries, so nothing can rot silently", () => {
    // The rule the format exists to enforce: "the default is X" is exactly the
    // sentence that stays in the file, unchanged and wrong, after X flips.
    // Only the entries are checked — the header explains the rule by QUOTING
    // the banned phrasing, and must stay free to do that.
    const [, entriesBody] = readFileSync(FAQ_PATH, "utf-8").split(/^---$/m);
    assert.ok(entriesBody, "expected a `---` line separating the header from the entries");
    // Every phrasing below states a CURRENT VALUE. The first version of this
    // file passed the check while saying "ships off" four times — the ban list
    // has to cover how people actually write a default, not just the words the
    // header happens to use.
    const bannedPhrases = [
      "the default is",
      "defaults to",
      "by default",
      "ships off",
      "ships on",
      "stays off",
      "is off until",
      "is on until",
      "off by default",
      "on by default",
    ];
    const found = bannedPhrases.filter((phrase) => entriesBody.toLowerCase().includes(phrase));
    assert.deepEqual(found, [], "state where to read the live value, not what the value is");
  });

  it("is registered in the help index like every other help page", () => {
    const index = readFileSync(path.join(HELPS_DIR, "index.md"), "utf-8");
    assert.ok(index.includes(`config/helps/${FAQ_FILENAME}`), "add a `## Help Pages` entry so an agent browsing index.md can discover it");
  });
});
