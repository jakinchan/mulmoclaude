// End-to-end wiring for the shell-shadows-`.env` diagnostic (#2604):
// env var in → real notifier entry out.
//
// `test_shadowedEnv.ts` pins the pure decisions. This file covers what
// those can't: that `announceShadowedEnv` actually reaches the bell, that
// the entry carries the i18n keys the UI localizes from, and — the part
// with real behaviour behind it — that the active set ends up describing
// the CURRENT conflict and nothing else across reboots.
//
// Runs against a tmpdir active.json, never `~/mulmoclaude/`.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _setFilePathsForTesting, initNotifier, listAll } from "../../server/notifier/engine.js";
import { isLegacyNotifierPluginData } from "../../server/events/notifications.js";
import { announceShadowedEnv } from "../../server/system/shadowedEnv.js";

let notifierDir: string;

// `publishNotification` is fire-and-forget by contract (the legacy
// wrapper swallows the promise), so tests wait for the write to land
// rather than awaiting a handle they don't get.
async function activeEntries(expected: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entries = await listAll();
    if (entries.length === expected) return entries;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return listAll();
}

beforeEach(() => {
  notifierDir = mkdtempSync(path.join(tmpdir(), "test-shadowed-env-notifier-"));
  _setFilePathsForTesting({
    active: path.join(notifierDir, "active.json"),
    history: path.join(notifierDir, "history.json"),
  });
  initNotifier({ publish: () => {} });
});

afterEach(() => {
  rmSync(notifierDir, { recursive: true, force: true });
});

describe("announceShadowedEnv", () => {
  it("raises a bell entry naming the shadowed key, with i18n keys for the UI", async () => {
    await announceShadowedEnv("GEMINI_API_KEY");
    const [entry] = await activeEntries(1);
    assert.ok(entry, "expected one active notification");
    assert.match(entry.body ?? "", /GEMINI_API_KEY/);
    // English stays as the log / macOS-Reminder fallback...
    assert.match(entry.title, /\.env/);
    // ...while the UI localizes from these.
    const legacy = isLegacyNotifierPluginData(entry.pluginData) ? entry.pluginData : null;
    assert.equal(legacy?.i18n?.titleKey, "shadowedEnv.title");
    assert.equal(legacy?.i18n?.bodyKey, "shadowedEnv.body");
  });

  it("stays silent when nothing is shadowed", async () => {
    await announceShadowedEnv(undefined);
    assert.deepEqual(await listAll(), []);
  });

  it("never puts a secret VALUE in the bell — the launcher sends names only", async () => {
    await announceShadowedEnv("GEMINI_API_KEY");
    const [entry] = await activeEntries(1);
    assert.ok(!`${entry.title}${entry.body ?? ""}`.includes("="));
  });

  it("does not stack a duplicate when a reboot finds the same conflict", async () => {
    await announceShadowedEnv("A,B");
    await activeEntries(1);
    await announceShadowedEnv("B,A"); // same set, whatever order dotenv parsed it in
    assert.equal((await listAll()).length, 1);
  });

  it("replaces the entry when one of two keys gets fixed, instead of leaving a stale one", async () => {
    await announceShadowedEnv("A,B");
    await activeEntries(1);
    await announceShadowedEnv("A"); // user unset B in their shell
    const entries = await activeEntries(1);
    assert.equal(entries.length, 1, "the old two-key entry must not survive alongside the new one");
    assert.match(entries[0].body ?? "", /A/);
    assert.ok(!(entries[0].body ?? "").includes("B"), "the fixed key must not still be named");
  });

  it("clears the entry once the conflict is gone entirely", async () => {
    await announceShadowedEnv("A");
    await activeEntries(1);
    await announceShadowedEnv(undefined); // user fixed their shell
    assert.deepEqual(await listAll(), []);
  });
});
