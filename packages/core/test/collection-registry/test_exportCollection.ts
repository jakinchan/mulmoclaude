import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { writeCollectionExport, type ExportMeta } from "../../src/collection/registry/server/exportCollection.ts";

const meta: ExportMeta = {
  author: "isamu",
  slug: "movies",
  version: "1.2.0",
  title: "映画リスト",
  description: "Movies I track.",
  tags: ["entertainment"],
  license: "MIT",
};

let wsRoot: string;
const skillDir = () => path.join(wsRoot, ".claude", "skills", "movies");
const dataDir = () => path.join(wsRoot, "data", "movies", "items");
const outDir = () => path.join(wsRoot, "data", "registry-export", "isamu", "movies");

function seedWorkspace(): void {
  mkdirSync(path.join(skillDir(), "views"), { recursive: true });
  writeFileSync(path.join(skillDir(), "SKILL.md"), "---\nname: movies\ndescription: x\n---\n# Movies");
  writeFileSync(path.join(skillDir(), "schema.json"), JSON.stringify({ title: "映画リスト", dataPath: "data/movies/items" }));
  writeFileSync(path.join(skillDir(), "views", "cinema.html"), "<!doctype html>");
  writeFileSync(path.join(skillDir(), "screenshot.png"), "PNG");
  writeFileSync(path.join(skillDir(), ".origin.json"), "{}"); // must NOT be exported
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(path.join(dataDir(), "a.json"), JSON.stringify({ id: "a", title: "A" }));
  writeFileSync(path.join(dataDir(), "with-email.json"), JSON.stringify({ id: "b", note: "reach me at me@example.com" }));
  // Built at runtime so the test source carries no literal credential pattern.
  const fakeToken = `ghp_${"a".repeat(36)}`;
  writeFileSync(path.join(dataDir(), "with-secret.json"), JSON.stringify({ id: "c", note: fakeToken }));
  // Sync state, not a record. Lives beside the records so the two reset
  // together (`calendarBackfillState.ts`), and every reader of a data dir
  // skips dot-prefixed names — the export must too.
  writeFileSync(path.join(dataDir(), ".calendar-sync.json"), JSON.stringify({ calendarId: "someone@example.com", walkedAt: "2026-08-10T00:00:00.000Z" }));
}

describe("writeCollectionExport", () => {
  beforeEach(() => {
    wsRoot = mkdtempSync(path.join(tmpdir(), "mc-export-"));
    seedWorkspace();
  });
  afterEach(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("writes the bundle + meta.json + seed, skipping secrets and warning on PII", async () => {
    const result = await writeCollectionExport({ workspaceRoot: wsRoot, skillDir: skillDir(), dataDir: dataDir(), meta, includeSeed: true });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.outputPath, "data/registry-export/isamu/movies");

    for (const file of ["SKILL.md", "schema.json", "screenshot.png", "meta.json"]) {
      assert.ok(existsSync(path.join(outDir(), file)), `expected ${file}`);
    }
    assert.ok(existsSync(path.join(outDir(), "views", "cinema.html")));
    assert.ok(!existsSync(path.join(outDir(), ".origin.json")), ".origin.json must not be exported");

    const writtenMeta = JSON.parse(readFileSync(path.join(outDir(), "meta.json"), "utf-8"));
    assert.equal(writtenMeta.author, "isamu");
    assert.equal(writtenMeta.title, "映画リスト");
    assert.equal(writtenMeta.dataConsent, true, "dataConsent set when seed exported");

    // seed: clean + email kept; secret skipped
    assert.ok(existsSync(path.join(outDir(), "seed", "items", "a.json")));
    assert.ok(existsSync(path.join(outDir(), "seed", "items", "with-email.json")));
    assert.ok(!existsSync(path.join(outDir(), "seed", "items", "with-secret.json")), "secret record skipped");
    assert.equal(result.seedCount, 2);
    assert.equal(result.seedSkipped, 1);
    assert.match(result.warnings.join("\n"), /credential/);
    assert.match(result.warnings.join("\n"), /PII/);
  });

  // #2853: the marker carries the user's calendar id — an email address for any
  // non-primary calendar — so shipping it in a published bundle is a leak, and
  // counting it would report seed data (and `dataConsent`) for a collection
  // that has none.
  it("never exports a dot-prefixed state file as seed data", async () => {
    const result = await writeCollectionExport({ workspaceRoot: wsRoot, skillDir: skillDir(), dataDir: dataDir(), meta, includeSeed: true });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(!existsSync(path.join(outDir(), "seed", "items", ".calendar-sync.json")), "sync state must never reach the bundle");
    const bundled = readFileSync(path.join(outDir(), "meta.json"), "utf-8");
    assert.ok(!bundled.includes("someone@example.com"), "the calendar id must not leak into the bundle");
  });

  // A data dir holding ONLY state must export as no seed at all — otherwise the
  // bundle claims data consent for data it does not have.
  it("reports no seed and no dataConsent when only state files are present", async () => {
    const stateOnly = path.join(wsRoot, "data", "state-only", "items");
    mkdirSync(stateOnly, { recursive: true });
    writeFileSync(path.join(stateOnly, ".calendar-sync.json"), JSON.stringify({ calendarId: "primary", walkedAt: "2026-08-10T00:00:00.000Z" }));

    const result = await writeCollectionExport({ workspaceRoot: wsRoot, skillDir: skillDir(), dataDir: stateOnly, meta, includeSeed: true });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.seedCount, 0);
    assert.equal(JSON.parse(readFileSync(path.join(outDir(), "meta.json"), "utf-8")).dataConsent, undefined);
  });

  it("omits seed + dataConsent when includeSeed is false", async () => {
    const result = await writeCollectionExport({ workspaceRoot: wsRoot, skillDir: skillDir(), dataDir: dataDir(), meta, includeSeed: false });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.seedCount, 0);
    assert.ok(!existsSync(path.join(outDir(), "seed")));
    const writtenMeta = JSON.parse(readFileSync(path.join(outDir(), "meta.json"), "utf-8"));
    assert.equal(writtenMeta.dataConsent, undefined);
  });

  it("rejects an invalid author", async () => {
    const result = await writeCollectionExport({
      workspaceRoot: wsRoot,
      skillDir: skillDir(),
      dataDir: dataDir(),
      meta: { ...meta, author: "bad/author" },
      includeSeed: false,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
  });

  it("rejects a skillDir that escapes the workspace", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "mc-export-outside-"));
    try {
      const result = await writeCollectionExport({ workspaceRoot: wsRoot, skillDir: outsideDir, dataDir: dataDir(), meta, includeSeed: false });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.status, 400);
      assert.ok(!existsSync(outDir()), "nothing written when a path escapes the workspace");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("hard-fails when a required bundle file (schema.json) is missing", async () => {
    rmSync(path.join(skillDir(), "schema.json"));
    const result = await writeCollectionExport({ workspaceRoot: wsRoot, skillDir: skillDir(), dataDir: dataDir(), meta, includeSeed: false });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.match(result.error, /required bundle file missing/);
    }
    assert.ok(!existsSync(outDir()), "no partial bundle written when a required file is missing");
  });
});
