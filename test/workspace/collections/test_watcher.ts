import "../../../server/workspace/collections/configure.js"; // configure @mulmoclaude/core/collection host binding for tests
// Watcher-layer tests for the collection-completion bell. Exercises:
//
//  - Boot reconcile (a pending item already on disk gets a bell entry
//    when `startCollectionWatchers` runs).
//  - Runtime collection removal (the schema dir is deleted; a manual
//    `_syncWatchersForTesting` call clears the now-orphaned entry).
//  - Schema flip from no-tracking to tracking (existing items get
//    entries on the next sync — the case Codex flagged).
//  - The per-key single-flight scheduler (`scheduleItemReconcile`):
//    rapid-fire calls coalesce into one publish plus one trailing
//    pass, so concurrent reconciles can't race the engine's write
//    queue into duplicate entries.
//
// `fs.watch` event timing is too flaky to assert against directly —
// the watcher boots fine in production but a Node test that writes a
// file and immediately checks the bell can land before the OS has
// dispatched the event. We exercise the watcher's logic through
// `_syncWatchersForTesting` (sync the watcher set on demand) and
// `_scheduleItemReconcileForTesting` (drive the single-flight slot
// directly).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _setFilePathsForTesting, initNotifier, listAll } from "../../../server/notifier/engine.js";
import {
  _scheduleItemReconcileForTesting,
  _tickTimeTriggersForTesting,
  _scheduleCollectionReconcileForTesting,
  _handleStoreChangeForTesting,
  _syncWatchersForTesting,
  startCollectionWatchers,
  stopCollectionWatchers,
} from "../../../server/workspace/collections/watcher.js";
import { loadCollection, storeFor } from "@mulmoclaude/core/collection/server";
import type { CollectionSchema } from "../../../server/workspace/collections/types.js";
import type { LoadedCollection } from "@mulmoclaude/core/collection/server";

let workdir: string;
let userDir: string;
let notifierDir: string;

const SLUG = "test-watcher";

// These tests boot the watcher with an EXPLICIT `workspaceRoot` (a tmpdir), so
// the bell ids they produce carry that root. Production does not: the host
// starts its watchers with no root override, and its ids stay the bare
// `collection-completion:<slug>:<itemId>` that `active.json` already holds.
const legacyIdFor = (slug: string, itemId: string): string => `collection-completion:@${workdir}\u0000${slug}:${itemId}`;

function buildSchema(extra: Partial<CollectionSchema> = {}): CollectionSchema {
  return {
    title: "Test Watcher",
    icon: "check_circle",
    dataPath: `data/${SLUG}/items`,
    primaryKey: "id",
    fields: {
      id: { type: "string", label: "ID", primary: true, required: true },
      read: { type: "boolean", label: "Read", required: true },
    },
    completionField: "read",
    completionDoneValues: ["true"],
    ...extra,
  };
}

function writeSchema(schema: CollectionSchema): void {
  const skillDir = path.join(workdir, ".claude/skills", SLUG);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${SLUG}\ndescription: test\n---\nbody\n`);
  writeFileSync(path.join(skillDir, "schema.json"), JSON.stringify(schema));
}

function deleteSchemaDir(): void {
  rmSync(path.join(workdir, ".claude/skills", SLUG), { recursive: true, force: true });
}

function writeItem(itemId: string, body: Record<string, unknown>): void {
  const dataDir = path.join(workdir, "data", SLUG, "items");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, `${itemId}.json`), JSON.stringify({ id: itemId, ...body }));
}

async function activeCompletionEntries(): Promise<{ id: string; legacyId: string }[]> {
  const entries = await listAll();
  return entries
    .filter((entry) => {
      const data = entry.pluginData as Record<string, unknown> | undefined;
      return data?.legacy === true && typeof data.legacyId === "string" && (data.legacyId as string).startsWith("collection-completion:");
    })
    .map((entry) => ({
      id: entry.id,
      legacyId: (entry.pluginData as Record<string, unknown>).legacyId as string,
    }));
}

beforeEach(async () => {
  workdir = mkdtempSync(path.join(tmpdir(), "test-watcher-"));
  userDir = mkdtempSync(path.join(tmpdir(), "test-watcher-user-"));
  notifierDir = mkdtempSync(path.join(tmpdir(), "test-watcher-notifier-"));
  _setFilePathsForTesting({
    active: path.join(notifierDir, "active.json"),
    history: path.join(notifierDir, "history.json"),
  });
  initNotifier({ publish: () => {} });
  // Make sure a previous test's watcher state didn't leak.
  await stopCollectionWatchers();
});

afterEach(async () => {
  await stopCollectionWatchers();
  rmSync(workdir, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
  rmSync(notifierDir, { recursive: true, force: true });
});

describe("startCollectionWatchers boot reconcile", () => {
  it("publishes bell entries for pending items already on disk at boot", async () => {
    writeSchema(buildSchema());
    writeItem("a", { read: false });
    writeItem("b", { read: true });
    writeItem("c", { read: false });

    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
    });

    const entries = await activeCompletionEntries();
    const legacyIds = entries.map((entry) => entry.legacyId).sort();
    assert.deepEqual(legacyIds, [legacyIdFor(SLUG, "a"), legacyIdFor(SLUG, "c")]);
  });

  it("ignores collections that don't declare completionField", async () => {
    writeSchema(buildSchema({ completionField: undefined, completionDoneValues: undefined }));
    writeItem("a", { read: false });

    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
    });

    assert.equal((await activeCompletionEntries()).length, 0);
  });
});

describe("syncWatchers runtime drift", () => {
  it("clears the entry when the collection is deleted at runtime", async () => {
    writeSchema(buildSchema());
    writeItem("a", { read: false });

    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
    });
    assert.equal((await activeCompletionEntries()).length, 1);

    deleteSchemaDir();
    await _syncWatchersForTesting();

    assert.equal((await activeCompletionEntries()).length, 0);
  });

  it("publishes for a still-pending item when completionField is added later", async () => {
    // Schema without completion tracking + one item.
    writeSchema(buildSchema({ completionField: undefined, completionDoneValues: undefined }));
    writeItem("a", { read: false });

    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
    });
    assert.equal((await activeCompletionEntries()).length, 0);

    // Flip the schema to start tracking — re-sync should fill in the entry.
    writeSchema(buildSchema());
    await _syncWatchersForTesting();

    const entries = await activeCompletionEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.legacyId, legacyIdFor(SLUG, "a"));
  });

  it("clears entries when completionField is removed from the schema", async () => {
    writeSchema(buildSchema());
    writeItem("a", { read: false });

    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
    });
    assert.equal((await activeCompletionEntries()).length, 1);

    writeSchema(buildSchema({ completionField: undefined, completionDoneValues: undefined }));
    await _syncWatchersForTesting();

    assert.equal((await activeCompletionEntries()).length, 0);
  });
});

describe("scheduleItemReconcile single-flight", () => {
  it("produces exactly one bell entry from a rapid-fire burst on the same key", async () => {
    writeSchema(buildSchema());
    writeItem("a", { read: false });

    // Discover so the watcher module has discoveryOpts (the
    // single-flight path doesn't need a started watcher, but the
    // reconciler's readItem still needs the right workspaceRoot
    // threaded through).
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
    });
    // Boot reconcile may have already published an entry for the
    // pending item; record that baseline and assert the burst added
    // at most one more (in practice: zero — `ensure*` is idempotent).
    const baseline = (await activeCompletionEntries()).length;

    // Fire ten concurrent reconciles. With the single-flight slot, all
    // ten collapse into one in-flight reconcile + one trailing re-run.
    // Without it, each would `listAll → publish` while the others'
    // writes are still queued, producing duplicate entries.
    const schema = buildSchema();
    const dataDir = path.join(workdir, "data", SLUG, "items");
    const promises = Array.from({ length: 10 }, () =>
      _scheduleItemReconcileForTesting({ slug: SLUG, source: "project", schema, dataDir, skillDir: dataDir } as unknown as LoadedCollection, "a"),
    );
    await Promise.all(promises);

    const after = (await activeCompletionEntries()).length;
    // Either there was already a boot entry (baseline=1, after=1) or
    // there wasn't (baseline=0, after=1). Either way, the burst added
    // at most one entry — never two.
    assert.equal(after, Math.max(baseline, 1), "rapid-fire reconciles must not produce duplicate entries");
  });
});

describe("storage (sqlite) collection reconciliation", () => {
  const DB_SLUG = "test-watcher-db";

  function writeDbSchema(): void {
    const skillDir = path.join(workdir, ".claude/skills", DB_SLUG);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${DB_SLUG}\ndescription: test\n---\nbody\n`);
    writeFileSync(
      path.join(skillDir, "schema.json"),
      JSON.stringify({
        title: "DB Watcher",
        icon: "check_circle",
        storage: { type: "sqlite", path: `data/${DB_SLUG}.db` },
        primaryKey: "id",
        fields: {
          id: { type: "string", label: "ID", primary: true, required: true },
          read: { type: "boolean", label: "Read", required: true },
        },
        completionField: "read",
        completionDoneValues: ["true"],
      }),
    );
  }

  it("bells a pending sqlite record and clears it when it turns done", async () => {
    writeDbSchema();
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
      triggerTickIntervalMs: null,
    });
    const collection = await loadCollection(DB_SLUG, { workspaceRoot: workdir, userSkillsDir: userDir });
    assert.ok(collection);
    const store = storeFor(collection, { workspaceRoot: workdir });
    assert.ok(store.write);

    await store.write("a", { id: "a", read: false });
    await _scheduleCollectionReconcileForTesting(DB_SLUG);
    let legacyIds = (await activeCompletionEntries()).map((entry) => entry.legacyId);
    assert.ok(legacyIds.includes(legacyIdFor(DB_SLUG, "a")), `expected a bell for a, got ${JSON.stringify(legacyIds)}`);

    await store.write("a", { id: "a", read: true });
    await _scheduleCollectionReconcileForTesting(DB_SLUG);
    legacyIds = (await activeCompletionEntries()).map((entry) => entry.legacyId);
    assert.ok(!legacyIds.includes(legacyIdFor(DB_SLUG, "a")), "bell must clear once the record is done");
  });

  it("clears the bell when a pending sqlite record is DELETED (stale sweep)", async () => {
    writeDbSchema();
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
      triggerTickIntervalMs: null,
    });
    const collection = await loadCollection(DB_SLUG, { workspaceRoot: workdir, userSkillsDir: userDir });
    assert.ok(collection);
    const store = storeFor(collection, { workspaceRoot: workdir });
    assert.ok(store.write && store.delete);

    await store.write("b", { id: "b", read: false });
    await _scheduleCollectionReconcileForTesting(DB_SLUG);
    let legacyIds = (await activeCompletionEntries()).map((entry) => entry.legacyId);
    assert.ok(legacyIds.includes(legacyIdFor(DB_SLUG, "b")));

    // One db file holds every record — a delete produces no per-item event,
    // so the full-pass reconcile must pair with the stale sweep (PR #2204
    // review finding) to clear the removed record's bell.
    await store.delete("b");
    await _scheduleCollectionReconcileForTesting(DB_SLUG);
    legacyIds = (await activeCompletionEntries()).map((entry) => entry.legacyId);
    assert.ok(!legacyIds.includes(legacyIdFor(DB_SLUG, "b")), "bell must clear when the record is deleted");
  });
});

describe("watcher set bookkeeping", () => {
  const BAD_SLUG = "test-watcher-unmountable";

  // Discovery accepts this collection (the dataPath resolves inside the
  // workspace and need not exist yet), but mounting it CANNOT succeed: a
  // regular file sits where the records directory would go, so the starter's
  // `mkdir` throws ENOTDIR, gets logged, and the collection stays out of
  // `watchers` — the "attempted but not mounted" shape.
  function writeUnmountableSchema(): void {
    // The records dir path itself is a regular FILE: discovery still accepts
    // the schema (the path resolves inside the workspace), but the starter's
    // `mkdir` on it throws, so the watcher never mounts.
    const blocker = path.join(workdir, "data", "blocked", "items");
    mkdirSync(path.dirname(blocker), { recursive: true });
    writeFileSync(blocker, "not a directory");
    const skillDir = path.join(workdir, ".claude/skills", BAD_SLUG);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${BAD_SLUG}\ndescription: test\n---\nbody\n`);
    writeFileSync(
      path.join(skillDir, "schema.json"),
      JSON.stringify({
        title: "Unmountable",
        icon: "warning",
        dataPath: "data/blocked/items",
        primaryKey: "id",
        fields: { id: { type: "string", label: "ID", primary: true, required: true } },
      }),
    );
  }

  it("a collection that never mounts does not make every tick look like a mutation", async () => {
    writeUnmountableSchema();
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
      triggerTickIntervalMs: null,
    });

    // Nothing changed between these two ticks. Before the fix, the retried
    // collection reported a mutation every time, so the stale sweep ran on
    // every rediscovery poll for as long as the failure persisted.
    assert.equal(await _syncWatchersForTesting(), false, "a quiet tick must not sweep");
    assert.equal(await _syncWatchersForTesting(), false, "and must stay quiet");
  });

  it("still reports a mutation when a watcher really mounts", async () => {
    writeUnmountableSchema();
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
      triggerTickIntervalMs: null,
    });
    assert.equal(await _syncWatchersForTesting(), false);

    // A real, mountable collection appearing IS a mutation — the fix must not
    // suppress that signal.
    writeSchema(buildSchema());
    assert.equal(await _syncWatchersForTesting(), true, "a newly mounted watcher must still sweep");
  });
});

describe("dataSource (csv) collection — bells now reconcile", () => {
  const CSV_SLUG = "test-watcher-csv-bell";

  function writeCsvSchema(overrides: Record<string, unknown> = {}): void {
    const skillDir = path.join(workdir, ".claude/skills", CSV_SLUG);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${CSV_SLUG}\ndescription: test\n---\nbody\n`);
    writeFileSync(
      path.join(skillDir, "schema.json"),
      JSON.stringify({
        title: "CSV Bells",
        icon: "table",
        dataSource: { type: "csv", path: `data/${CSV_SLUG}.csv` },
        primaryKey: "id",
        fields: {
          id: { type: "string", label: "ID", primary: true },
          read: { type: "string", label: "Read" },
        },
        completionField: "read",
        completionDoneValues: ["true"],
        ...overrides,
      }),
    );
  }

  function writeCsvCollection(rows: string): void {
    const csv = path.join(workdir, "data", `${CSV_SLUG}.csv`);
    mkdirSync(path.dirname(csv), { recursive: true });
    writeFileSync(csv, rows);
    writeCsvSchema();
  }

  // `completionField` is NOT among the keys zod forbids on a dataSource
  // collection, so a CSV collection may declare bells — but the old
  // dataSource watcher only published, never reconciled, and the clock tick
  // skipped dataSource outright. The bells therefore never fired. Routing
  // every backend through the same store-reported change fixes it
  // structurally rather than by adding another special case.
  it("bells a pending row from the boot reconcile", async () => {
    writeCsvCollection("id,read\na,false\n");
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
      triggerTickIntervalMs: null,
    });
    const legacyIds = (await activeCompletionEntries()).map((entry) => entry.legacyId);
    assert.ok(legacyIds.includes(legacyIdFor(CSV_SLUG, "a")), "a pending CSV row must bell");
  });

  it("clears the bell once the row turns done", async () => {
    writeCsvCollection("id,read\na,false\n");
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
      triggerTickIntervalMs: null,
    });
    assert.equal((await activeCompletionEntries()).length, 1);

    writeFileSync(path.join(workdir, "data", `${CSV_SLUG}.csv`), "id,read\na,true\n");
    await _scheduleCollectionReconcileForTesting(CSV_SLUG);

    const legacyIds = (await activeCompletionEntries()).map((entry) => entry.legacyId);
    assert.ok(!legacyIds.includes(legacyIdFor(CSV_SLUG, "a")), "the bell must clear when the row is done");
  });

  // Codex review on PR #2243: the clock tick hard-skipped dataSource, with
  // the rationale "no reconcilable records (and zod forbids `spawn`)". zod
  // forbids `spawn`, but NOT `triggerField` — and the skip sat BEFORE the
  // triggerField gate, so it swallowed that case too. A trigger date is the
  // one state change that arrives with the file untouched, so a CSV row that
  // was pending-but-not-yet-due could never bell: no data event to react to,
  // and the clock path refused to look.
  it("bells a row whose trigger date passes while the file never changes", async () => {
    writeCsvCollection("id,dueOn,read\na,2026-06-10,false\n");
    writeCsvSchema({
      fields: {
        id: { type: "string", label: "ID", primary: true },
        dueOn: { type: "date", label: "Due" },
        read: { type: "string", label: "Read" },
      },
      triggerField: "dueOn",
    });
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
      triggerTickIntervalMs: null,
    });
    await _tickTimeTriggersForTesting(new Date(2026, 5, 9));
    assert.equal((await activeCompletionEntries()).length, 0, "precondition: not due yet, so no bell");

    // Only the clock moves — the CSV is byte-identical.
    await _tickTimeTriggersForTesting(new Date(2026, 5, 10));

    const legacyIds = (await activeCompletionEntries()).map((entry) => entry.legacyId);
    assert.deepEqual(legacyIds, [legacyIdFor(CSV_SLUG, "a")], "the clock tick must bell the now-due row");
  });

  // Codex review on PR #2243: routing CSV through the shared reconcile made
  // boot and data events derive bells, but the schema-change pass kept the
  // old dataSource shortcut of publishing without reconciling. Completion
  // rules live in the SCHEMA, so editing them changes which rows are pending
  // while every row stays byte-identical — the one change a data event can
  // never report.
  //
  // The assertion deliberately runs in the CREATE direction. A rule edit that
  // turns a pending row done is also cleared by the stale sweep that closes
  // the tick, so it passes with or without the fix; only a row that becomes
  // NEWLY pending isolates the re-derivation, because no sweep invents bells.
  it("bells a row that a schema-only edit turns pending", async () => {
    writeCsvCollection("id,read\na,true\n");
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
      triggerTickIntervalMs: null,
    });
    assert.equal((await activeCompletionEntries()).length, 0, "precondition: the row counts as done, so no bell");

    // Same row, new rule: only "yes" means done, so "true" is now pending.
    writeCsvSchema({ completionDoneValues: ["yes"] });
    await _syncWatchersForTesting();

    const legacyIds = (await activeCompletionEntries()).map((entry) => entry.legacyId);
    assert.deepEqual(legacyIds, [legacyIdFor(CSV_SLUG, "a")], "the schema pass must derive the new bell");
  });
});

describe("store change handling uses the CURRENT schema", () => {
  // Codex review on PR #2243: the subscription callback used to close over
  // the collection resolved at mount time. A schema-only edit refreshes the
  // watcher entry in place (nothing remounts, because the storage location
  // didn't move), so a stale closure would keep reconciling against the old
  // rules and undo what the schema-change pass had just converged on.
  it("stops belling an item after completionField is removed from the schema", async () => {
    writeSchema(buildSchema());
    writeItem("a", { read: false });
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
      triggerTickIntervalMs: null,
    });
    assert.equal((await activeCompletionEntries()).length, 1, "precondition: the bell exists");

    // Schema-only edit: drop completion tracking. The sync pass converges
    // the bell away and refreshes the watcher's cached collection.
    writeSchema(buildSchema({ completionField: undefined, completionDoneValues: undefined }));
    await _syncWatchersForTesting();
    assert.equal((await activeCompletionEntries()).length, 0, "the schema pass must clear it");

    // Now a record event arrives, exactly as the live subscription would
    // deliver it. With a stale snapshot this re-created the bell.
    await _handleStoreChangeForTesting(SLUG, { kind: "item", itemId: "a" });
    assert.equal((await activeCompletionEntries()).length, 0, "a later event must not resurrect it under the old schema");
  });
});

describe("a watch that cannot arm is retried, not marked mounted", () => {
  // Codex review on PR #2243: moving the fs.watch behind the store contract
  // made arming asynchronous, and the bridge that adapted it back to a
  // synchronous unsubscribe dropped the failure on the floor. The slug was
  // then registered as mounted, and `startNewWatchers` skips slugs already in
  // `watchers` — so nothing ever re-armed it and the collection served stale
  // data until the process restarted. Before the refactor the inline
  // `fs.watch` threw, `startWatcherFor` returned false, and the next sync
  // tick retried.
  //
  // The arm failure is induced the way it stays deterministic: `watchDirectory`
  // starts with `mkdir(dir, { recursive: true })`, which throws ENOTDIR when a
  // REGULAR FILE sits on the records path. No inotify exhaustion needed.
  function blockRecordsDir(): void {
    const dataDir = path.join(workdir, "data", SLUG, "items");
    mkdirSync(path.dirname(dataDir), { recursive: true });
    writeFileSync(dataDir, "not a directory");
  }

  it("remounts on a later sync once the obstruction clears", async () => {
    writeSchema(buildSchema());
    blockRecordsDir();
    await startCollectionWatchers({
      discoveryOpts: { workspaceRoot: workdir, userSkillsDir: userDir },
      rediscoveryIntervalMs: null,
      triggerTickIntervalMs: null,
    });

    // The obstruction goes away (the agent removes the stray file and writes
    // a real record). A watcher wrongly marked mounted never comes back for it.
    rmSync(path.join(workdir, "data", SLUG, "items"), { force: true });
    writeItem("a", { read: false });
    assert.equal(await _syncWatchersForTesting(), true, "the retry must mount the collection it failed to arm");

    const legacyIds = (await activeCompletionEntries()).map((entry) => entry.legacyId);
    assert.deepEqual(legacyIds, [legacyIdFor(SLUG, "a")], "and its boot reconcile must bell the pending item");
  });
});
