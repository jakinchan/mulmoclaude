// Unit tests for the snapshot pipeline (#763 PR 2).
//
// Focus areas:
//   - appendSnapshot writes a file with the expected name + meta
//   - listSnapshots returns newest-first, parses meta correctly
//   - readSnapshot round-trips body + meta
//   - GC retains "newest 100 OR within 180 days" — only deletes when
//     BOTH conditions are violated
//   - GC is idempotent and tolerant of stray / malformed filenames
//   - Snapshots for unrelated slugs are never touched by another
//     slug's GC

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "fs/promises";

import path from "path";
import { writeWikiPage } from "../../../server/workspace/wiki-pages/io.js";
import {
  appendSnapshot,
  gcSnapshots,
  historyDir,
  isSafeStamp,
  listSnapshots,
  readSnapshot,
  SNAPSHOT_RETAIN_COUNT,
  SNAPSHOT_RETAIN_DAYS,
  stripSnapshotMeta,
} from "../../../server/workspace/wiki-pages/snapshot.js";
import { WORKSPACE_DIRS } from "../../../server/workspace/paths.js";
import { makeTempDir } from "../../helpers/tempDir.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SLUG = "test-page";

let root: string;

before(async () => {
  root = makeTempDir("snapshot-test-");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRawSnapshot(
  workspaceRoot: string,
  slug: string,
  filenameStamp: string,
  body: string,
  meta: Record<string, unknown> = {},
  shortIdTail = "fixedid",
): Promise<string> {
  // Direct filesystem write so tests can seed history with arbitrary
  // timestamps (even stamps in the past, where appendSnapshot would
  // refuse to step backwards). Returns the full public stamp
  // (`<filenameStamp>-<shortId>`) the production code now exposes.
  const stamp = `${filenameStamp}-${shortIdTail}`;
  const fileName = `${stamp}.md`;
  const dir = path.join(workspaceRoot, WORKSPACE_DIRS.wikiHistory, slug);
  await mkdir(dir, { recursive: true });
  const text = ["---", `_snapshot_ts: "${filenameStampToIso(filenameStamp)}"`, `_snapshot_editor: ${meta._snapshot_editor ?? "user"}`, "---", "", body].join(
    "\n",
  );
  await writeFile(path.join(dir, fileName), text, "utf-8");
  return stamp;
}

function filenameStampToIso(filenameStamp: string): string {
  // 2026-04-28T01-23-45-789Z → 2026-04-28T01:23:45.789Z
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(filenameStamp);
  if (!match) throw new Error(`bad filenameStamp ${filenameStamp}`);
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

function dateToFilenameStamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-").replace(".", "-");
}

describe("isSafeStamp", () => {
  it("accepts the full <filenameStamp>-<shortId> shape", () => {
    assert.equal(isSafeStamp("2026-04-28T01-23-45-789Z-abc12345"), true);
  });

  it("rejects the bare time-only stamp (must include shortId tail)", () => {
    // Codex iter-1: exposing only the time part would alias two
    // same-millisecond writes. The route param must include the
    // shortId so listSnapshots / readSnapshot can resolve unambiguously.
    assert.equal(isSafeStamp("2026-04-28T01-23-45-789Z"), false);
  });

  it("rejects path-traversal attempts", () => {
    assert.equal(isSafeStamp("../etc/passwd"), false);
    assert.equal(isSafeStamp("..\\foo"), false);
    assert.equal(isSafeStamp(""), false);
  });

  it("rejects shape that's missing the trailing Z or millisecond block", () => {
    assert.equal(isSafeStamp("2026-04-28T01-23-45-abc"), false);
    assert.equal(isSafeStamp("2026-04-28T01:23:45.789Z-abc"), false); // colons
  });
});

describe("stripSnapshotMeta", () => {
  it("removes only the `_snapshot_*` keys, preserves everything else", () => {
    const input = {
      title: "X",
      created: "2026-04-01",
      updated: "2026-04-28T01:00:00.000Z",
      _snapshot_ts: "2026-04-28T01:00:00.000Z",
      _snapshot_editor: "user",
      _snapshot_session: "abc",
      _snapshot_reason: "typo fix",
      tags: ["a", "b"],
    };
    const out = stripSnapshotMeta(input);
    assert.deepEqual(out, {
      title: "X",
      created: "2026-04-01",
      updated: "2026-04-28T01:00:00.000Z",
      tags: ["a", "b"],
    });
  });

  it("is a no-op when no snapshot keys are present", () => {
    const input = { title: "X" };
    assert.deepEqual(stripSnapshotMeta(input), { title: "X" });
  });
});

describe("appendSnapshot — write + retrieve", () => {
  it("creates a snapshot file and listSnapshots surfaces its meta", async () => {
    const workspaceRoot = makeTempDir("snapshot-write-");
    const fixedNow = new Date("2026-04-28T01:23:45.789Z");
    await appendSnapshot(
      SLUG,
      null,
      "---\ntitle: hi\n---\n\nbody\n",
      { editor: "user", reason: "first save" },
      { workspaceRoot, now: () => fixedNow, shortId: () => "fixedid" },
    );

    const snapshots = await listSnapshots(SLUG, { workspaceRoot });
    assert.equal(snapshots.length, 1);
    // Public stamp is `<filenameStamp>-<shortId>` to disambiguate
    // same-millisecond writes (codex iter-1).
    const [snapshot] = snapshots;
    assert.ok(snapshot);
    assert.equal(snapshot.stamp, "2026-04-28T01-23-45-789Z-fixedid");
    assert.equal(snapshot.editor, "user");
    assert.equal(snapshot.reason, "first save");
    assert.equal(snapshot.ts, "2026-04-28T01:23:45.789Z");

    const single = await readSnapshot(SLUG, snapshot.stamp, { workspaceRoot });
    assert.ok(single, "expected snapshot to round-trip");
    assert.equal(single.body, "body\n");
    assert.equal(single.meta.title, "hi");
    assert.equal(single.meta._snapshot_reason, "first save");

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("orders snapshots newest-first regardless of write order", async () => {
    const workspaceRoot = makeTempDir("snapshot-order-");

    // Seed three snapshots with descending timestamps. The on-disk
    // dir-listing order is OS-dependent so we rely on the in-helper
    // sort to surface the canonical newest-first ordering.
    const seeds = ["2026-04-26T00-00-00-000Z", "2026-04-28T00-00-00-000Z", "2026-04-27T00-00-00-000Z"];
    for (const filenameStamp of seeds) await writeRawSnapshot(workspaceRoot, SLUG, filenameStamp, "body");

    const snapshots = await listSnapshots(SLUG, { workspaceRoot });
    const stamps = snapshots.map((entry) => entry.stamp);
    // Public stamp = `<filenameStamp>-fixedid` (writeRawSnapshot's default tail).
    assert.deepEqual(stamps, ["2026-04-28T00-00-00-000Z-fixedid", "2026-04-27T00-00-00-000Z-fixedid", "2026-04-26T00-00-00-000Z-fixedid"]);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("returns an empty list for a slug with no history", async () => {
    const workspaceRoot = makeTempDir("snapshot-empty-");
    const snapshots = await listSnapshots("never-saved", { workspaceRoot });
    assert.deepEqual(snapshots, []);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("readSnapshot returns null on unknown stamp", async () => {
    const workspaceRoot = makeTempDir("snapshot-miss-");
    await writeRawSnapshot(workspaceRoot, SLUG, "2026-04-28T01-23-45-789Z", "body");

    const miss = await readSnapshot(SLUG, "2099-01-01T00-00-00-000Z-fakeid", { workspaceRoot });
    assert.equal(miss, null);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("readSnapshot rejects unsafe stamp strings (returns null, no throw)", async () => {
    const workspaceRoot = makeTempDir("snapshot-unsafe-");
    const out = await readSnapshot(SLUG, "../etc/passwd", { workspaceRoot });
    assert.equal(out, null);
    await rm(workspaceRoot, { recursive: true, force: true });
  });
});

describe("gcSnapshots — retention rule", () => {
  it("keeps every snapshot when the dir doesn't exist (no-op)", async () => {
    const workspaceRoot = makeTempDir("gc-noop-");
    await gcSnapshots("never-saved", new Date(), { workspaceRoot });
    // Just asserting it didn't throw is enough — the dir shouldn't
    // suddenly exist either.
    const dir = historyDir("never-saved", { workspaceRoot });
    await assert.rejects(() => readdir(dir));
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("deletes only entries that are BOTH outside top-100 AND older than 180 days", async () => {
    const workspaceRoot = makeTempDir("gc-rule-");
    const now = new Date("2026-04-28T00:00:00.000Z");

    // Seed 110 snapshots:
    //   - 100 within last 30 days (fresh, count-protected AND age-protected)
    //   - 10 from 365 days ago (outside top-100 by age but well past
    //     180-day cutoff — these should be deleted)
    // We arrange them so the 10 ancient ones come *after* the 100
    // recent ones in the sorted list (i.e. they're older and hence
    // outside the count window after sorting newest-first).
    for (let i = 0; i < 100; i++) {
      const date = new Date(now.getTime() - i * 60 * 1000); // 1-minute spacing
      await writeRawSnapshot(workspaceRoot, SLUG, dateToFilenameStamp(date), `recent-${i}`);
    }
    for (let i = 0; i < 10; i++) {
      const date = new Date(now.getTime() - 365 * ONE_DAY_MS - i * 60 * 1000);
      await writeRawSnapshot(workspaceRoot, SLUG, dateToFilenameStamp(date), `ancient-${i}`);
    }

    await gcSnapshots(SLUG, now, { workspaceRoot });
    const remaining = await listSnapshots(SLUG, { workspaceRoot });
    assert.equal(remaining.length, 100, "expected the 10 ancient snapshots to be GC'd");
  });

  it("keeps a snapshot in the count window even when it's older than 180 days", async () => {
    // Edge case: a slug with only 50 lifetime entries, 30 of which
    // are over 180 days old. None of them should be GC'd because
    // every single one is in the top-100 (count rule wins).
    const workspaceRoot = makeTempDir("gc-count-rule-");
    const now = new Date("2026-04-28T00:00:00.000Z");

    for (let i = 0; i < 30; i++) {
      const date = new Date(now.getTime() - (200 + i) * ONE_DAY_MS);
      await writeRawSnapshot(workspaceRoot, SLUG, dateToFilenameStamp(date), `old-${i}`);
    }
    for (let i = 0; i < 20; i++) {
      const date = new Date(now.getTime() - i * ONE_DAY_MS);
      await writeRawSnapshot(workspaceRoot, SLUG, dateToFilenameStamp(date), `recent-${i}`);
    }

    await gcSnapshots(SLUG, now, { workspaceRoot });
    const remaining = await listSnapshots(SLUG, { workspaceRoot });
    assert.equal(remaining.length, 50, "fewer than 100 entries — keep them all regardless of age");
  });

  it("keeps a snapshot in the age window even when it's outside the top-100", async () => {
    // Edge case: 200 snapshots all within 180 days. None should be
    // GC'd because every single one is age-protected (age rule wins).
    const workspaceRoot = makeTempDir("gc-age-rule-");
    const now = new Date("2026-04-28T00:00:00.000Z");

    for (let i = 0; i < 200; i++) {
      // Spread across 90 days — well within 180.
      const date = new Date(now.getTime() - i * 12 * 60 * 60 * 1000);
      await writeRawSnapshot(workspaceRoot, SLUG, dateToFilenameStamp(date), `entry-${i}`);
    }

    await gcSnapshots(SLUG, now, { workspaceRoot });
    const remaining = await listSnapshots(SLUG, { workspaceRoot });
    assert.equal(remaining.length, 200, "all entries within 180 days — keep them regardless of count");
  });

  it("does not touch other slugs' history", async () => {
    const workspaceRoot = makeTempDir("gc-isolation-");
    const now = new Date("2026-04-28T00:00:00.000Z");
    const oldStamp = dateToFilenameStamp(new Date(now.getTime() - 400 * ONE_DAY_MS));

    // Seed an ancient snapshot under "other-slug" that *would* be
    // GC'd if any code path mistakenly walked the wrong dir.
    await writeRawSnapshot(workspaceRoot, "other-slug", oldStamp, "irrelevant");
    await writeRawSnapshot(workspaceRoot, SLUG, dateToFilenameStamp(now), "fresh");

    await gcSnapshots(SLUG, now, { workspaceRoot });

    const otherDir = historyDir("other-slug", { workspaceRoot });
    const remaining = await readdir(otherDir);
    assert.equal(remaining.length, 1, "other slug's history must be untouched");
  });

  it("ignores files whose names don't match the stamp pattern", async () => {
    // A stray README or a half-written .tmp shouldn't break GC.
    const workspaceRoot = makeTempDir("gc-stray-");
    const dir = historyDir(SLUG, { workspaceRoot });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "README"), "stray", "utf-8");
    await writeFile(path.join(dir, "notes.txt"), "also stray", "utf-8");
    // One real ancient entry that *would* be GC'd to confirm GC ran.
    const ancient = dateToFilenameStamp(new Date("2024-01-01T00:00:00.000Z"));
    await writeRawSnapshot(workspaceRoot, SLUG, ancient, "ancient");
    // Force the count window to exclude `ancient` by adding 100 fresh.
    const now = new Date("2026-04-28T00:00:00.000Z");
    for (let i = 0; i < 100; i++) {
      const date = new Date(now.getTime() - i * 60 * 1000);
      await writeRawSnapshot(workspaceRoot, SLUG, dateToFilenameStamp(date), `fresh-${i}`);
    }

    await gcSnapshots(SLUG, now, { workspaceRoot });
    const remaining = await readdir(dir);
    // The two stray files survive untouched.
    assert.ok(remaining.includes("README"));
    assert.ok(remaining.includes("notes.txt"));
    // The ancient real snapshot was GC'd.
    assert.ok(!remaining.some((name) => name.startsWith("2024-01-01T")));
  });
});

describe("snapshot reads — symlink protection", () => {
  // Defence in depth: even if something with workspace write access
  // plants a symlink under `.history/<slug>/` whose name matches
  // FILENAME_RE, the read paths must NOT follow it. Otherwise the
  // bearer-authed history GET routes would surface arbitrary file
  // contents from outside the wiki tree (codex review iter-2 #917).
  it("listSnapshots ignores symlink entries even when they match the filename pattern", async () => {
    const workspaceRoot = makeTempDir("snap-symlink-list-");
    const slug = "evil-page";
    const dir = historyDir(slug, { workspaceRoot });
    await mkdir(dir, { recursive: true });

    const realStamp = dateToFilenameStamp(new Date("2026-04-28T05:00:00.000Z"));
    await writeRawSnapshot(workspaceRoot, slug, realStamp, "real body", { _snapshot_editor: "user" }, "real0000");

    const secret = path.join(workspaceRoot, "secret.txt");
    await writeFile(secret, "TOP-SECRET\n", "utf-8");
    const evilStamp = dateToFilenameStamp(new Date("2026-04-28T06:00:00.000Z"));
    const evilFile = path.join(dir, `${evilStamp}-evil0000.md`);
    await symlink(secret, evilFile);

    const summaries = await listSnapshots(slug, { workspaceRoot });
    assert.equal(summaries.length, 1, "symlink should be filtered out");
    const [summary] = summaries;
    assert.ok(summary);
    assert.equal(summary.stamp, `${realStamp}-real0000`);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("returns an empty list when the slug's history dir is itself a symlink", async () => {
    // A directory-level symlink would otherwise redirect the readdir
    // wholesale; per-entry isFile() filtering wouldn't help because
    // a regular file inside the symlink target that happens to match
    // FILENAME_RE would be served as a snapshot (codex review iter-3
    // #917).
    const workspaceRoot = makeTempDir("snap-symlink-dir-");
    const slug = "evil-page";
    const historyParent = path.join(workspaceRoot, WORKSPACE_DIRS.wikiHistory);
    await mkdir(historyParent, { recursive: true });

    // Build a real directory elsewhere with a snapshot-shaped file.
    const decoy = path.join(workspaceRoot, "decoy");
    await mkdir(decoy, { recursive: true });
    const decoyStamp = dateToFilenameStamp(new Date("2026-04-28T07:00:00.000Z"));
    await writeFile(path.join(decoy, `${decoyStamp}-decoy000.md`), "secret-content\n", "utf-8");

    // Plant the slug's history dir as a symlink pointing at decoy.
    await symlink(decoy, path.join(historyParent, slug));

    const summaries = await listSnapshots(slug, { workspaceRoot });
    assert.deepEqual(summaries, [], "symlinked history dir must not surface its target's contents");

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("appendSnapshot refuses to write when the slug's history dir is a symlink", async () => {
    // Codex review iter-4 #917: the read-side guard alone is not
    // enough — a planted directory symlink would otherwise let the
    // write land in the symlink target.
    const workspaceRoot = makeTempDir("snap-symlink-write-");
    const slug = "evil-page";
    const historyParent = path.join(workspaceRoot, WORKSPACE_DIRS.wikiHistory);
    await mkdir(historyParent, { recursive: true });
    const decoy = path.join(workspaceRoot, "decoy");
    await mkdir(decoy, { recursive: true });
    await symlink(decoy, path.join(historyParent, slug));

    await assert.rejects(appendSnapshot(slug, null, "---\n---\nbody\n", { editor: "user" }, { workspaceRoot }), /history dir is a symlink/);
    // The decoy directory must remain empty — nothing leaked through.
    const decoyContents = await readdir(decoy);
    assert.deepEqual(decoyContents, []);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("readSnapshot returns null for a symlink that matches the stamp pattern", async () => {
    const workspaceRoot = makeTempDir("snap-symlink-read-");
    const slug = "evil-page";
    const dir = historyDir(slug, { workspaceRoot });
    await mkdir(dir, { recursive: true });

    const secret = path.join(workspaceRoot, "secret.txt");
    await writeFile(secret, "TOP-SECRET\n", "utf-8");
    const evilStamp = dateToFilenameStamp(new Date("2026-04-28T06:00:00.000Z"));
    const evilFullStamp = `${evilStamp}-evil0000`;
    await symlink(secret, path.join(dir, `${evilFullStamp}.md`));

    const result = await readSnapshot(slug, evilFullStamp, { workspaceRoot });
    assert.equal(result, null, "symlink-backed stamp must not be readable");

    await rm(workspaceRoot, { recursive: true, force: true });
  });
});

describe("appendSnapshot via writeWikiPage — integration", () => {
  // Verifies the wiring from the io.ts choke point through to a
  // real on-disk snapshot. The previous tests called appendSnapshot
  // directly; here we make sure writeWikiPage's call site triggers
  // it on a meaningful body change but NOT on a no-op save.
  it("creates a snapshot when the body changes", async () => {
    const workspaceRoot = makeTempDir("wiki-integration-");
    await mkdir(path.join(workspaceRoot, WORKSPACE_DIRS.wikiPages), { recursive: true });

    const fixedNow = new Date("2026-04-28T01:23:45.789Z");
    await writeWikiPage("hello", "first body\n", { editor: "user" }, { workspaceRoot, now: () => fixedNow });

    // Second save with different body, slightly later timestamp.
    const later = new Date(fixedNow.getTime() + 60_000);
    await writeWikiPage("hello", "updated body\n", { editor: "user" }, { workspaceRoot, now: () => later });

    const snapshots = await listSnapshots("hello", { workspaceRoot });
    assert.equal(snapshots.length, 2, "two saves with different bodies → two snapshots");

    // The newest snapshot's body should match the second save.
    const [newestSummary] = snapshots;
    assert.ok(newestSummary);
    const newest = await readSnapshot("hello", newestSummary.stamp, { workspaceRoot });
    assert.ok(newest);
    assert.equal(newest.body, "updated body\n");

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("succeeds when snapshot append fails (page write must not surface the error)", async () => {
    // Codex review iter-3 #917: a snapshot failure must NOT fail the
    // page write — the file is already on disk, so propagating a 500
    // to the caller would be misleading. We provoke a snapshot
    // failure by pre-creating the slug's history dir as a regular
    // file: appendSnapshot will then fail to mkdir/write inside it.
    const workspaceRoot = makeTempDir("wiki-snap-fail-");
    await mkdir(path.join(workspaceRoot, WORKSPACE_DIRS.wikiPages), { recursive: true });
    const historyParent = path.join(workspaceRoot, WORKSPACE_DIRS.wikiHistory);
    await mkdir(historyParent, { recursive: true });
    // The slug's "history dir" is now a file, not a dir.
    await writeFile(path.join(historyParent, "broken"), "not a dir\n", "utf-8");

    await assert.doesNotReject(writeWikiPage("broken", "page body\n", { editor: "user" }, { workspaceRoot }), "writeWikiPage must swallow snapshot errors");

    // The page itself was written.
    const pageFile = path.join(workspaceRoot, WORKSPACE_DIRS.wikiPages, "broken.md");
    const pageBody = await readFile(pageFile, "utf-8");
    assert.match(pageBody, /page body/);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("does NOT create a snapshot when only auto-stamped meta changes", async () => {
    // hasMeaningfulChange filters out the case where the only diff
    // is the auto-stamped `updated` field. This test pins that
    // behaviour: writing the exact same body at a later timestamp
    // doesn't add a second snapshot.
    const workspaceRoot = makeTempDir("wiki-noop-");
    await mkdir(path.join(workspaceRoot, WORKSPACE_DIRS.wikiPages), { recursive: true });

    const firstSave = new Date("2026-04-28T01:00:00.000Z");
    await writeWikiPage("hello", "same body\n", { editor: "user" }, { workspaceRoot, now: () => firstSave });

    const secondSave = new Date("2026-04-28T01:05:00.000Z");
    await writeWikiPage("hello", "same body\n", { editor: "user" }, { workspaceRoot, now: () => secondSave });

    const snapshots = await listSnapshots("hello", { workspaceRoot });
    assert.equal(snapshots.length, 1, "no-op resave should not record a new snapshot");

    await rm(workspaceRoot, { recursive: true, force: true });
  });
});

// Sanity: the constants line up with the policy decision baked into
// the design doc. Drift here usually means a follow-up tweak that
// the plan file didn't get updated for.
describe("retention constants", () => {
  it("matches the documented policy", () => {
    assert.equal(SNAPSHOT_RETAIN_COUNT, 100);
    assert.equal(SNAPSHOT_RETAIN_DAYS, 180);
  });
});
