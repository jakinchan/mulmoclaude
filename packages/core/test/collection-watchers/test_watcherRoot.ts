// The watcher's change payloads must carry the root the watcher was STARTED
// for (U1). A `LoadedCollection` holds only absolute paths — `dataDir`,
// `skillDir` — so there is no root to recover from it after the fact; the root
// has to come from the discovery options the watcher is running under. A
// multi-root host mounts one watcher generation per project, and without this
// a direct file write in project A refreshes project B's open `tasks` view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  configureCollectionHost,
  setCollectionChangePublisher,
  COLLECTION_ROOT_REQUIRED,
  type CollectionChangePayload,
  type LoadedCollection,
} from "../../src/collection/server/index.ts";
import { configureNotifier, setNotifierFilePaths } from "../../src/notifier/index.ts";
import {
  configureCollectionWatchers,
  startCollectionWatchers,
  stopCollectionWatchers,
  _scheduleItemReconcileForTesting,
  WATCHER_ROOT_CONFLICT,
  type CollectionNotificationAdapter,
} from "../../src/collection-watchers/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const root = makeTempDir("cw-root-");
const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

configureCollectionHost({
  workspaceRoot: root,
  log: noopLog,
  paths: {
    userSkillsDir: path.join(root, ".user-skills"),
    projectSkillsDir: (wsRoot) => path.join(wsRoot, ".claude", "skills"),
    feedsRoot: (wsRoot) => path.join(wsRoot, "data", "feeds"),
    skillsStagingDir: (wsRoot) => path.join(wsRoot, "data", "skills"),
    archiveDir: "data/archive",
    collectionsRegistriesConfig: (wsRoot) => path.join(wsRoot, "config", "collections-registries.json"),
  },
  isPresetSlug: () => false,
});

configureNotifier({
  writeJson: async (filePath, data) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2));
  },
  publishEvent: () => {},
});
setNotifierFilePaths({ active: path.join(root, "active.json"), history: path.join(root, "history.json") });

const adapter: CollectionNotificationAdapter = {
  pluginPkg: "test-bells",
  priorityToSeverity: () => "nudge",
  buildNavigateTarget: (slug, itemId) => `/x/${slug}/${itemId}`,
  buildPluginData: ({ legacyId }) => ({ kind: "cw", legacyId }),
  readEntry: (pluginData) => {
    if (typeof pluginData !== "object" || pluginData === null) return null;
    const record = pluginData as Record<string, unknown>;
    return record.kind === "cw" && typeof record.legacyId === "string" ? { legacyId: record.legacyId, priority: "normal" } : null;
  },
};
configureCollectionWatchers({ adapter });

const SCHEMA = { primaryKey: "id", title: "Tasks", displayField: "name" } as never;
const asCollection = (slug: string, dataDir: string): LoadedCollection =>
  ({ slug, source: "project", schema: SCHEMA, dataDir, skillDir: dataDir }) as unknown as LoadedCollection;

const published: CollectionChangePayload[] = [];
setCollectionChangePublisher((payload) => published.push(payload));

function seededDataDir(): string {
  const dir = mkdtempSync(path.join(root, "coll-"));
  writeFileSync(path.join(dir, "t1.json"), JSON.stringify({ id: "t1", name: "Pending" }));
  published.length = 0;
  return dir;
}

test("a watcher started for an explicit root stamps that root on its payloads", async () => {
  const projectRoot = makeTempDir("cw-proj-");
  await startCollectionWatchers({
    discoveryOpts: { workspaceRoot: projectRoot, userSkillsDir: path.join(projectRoot, ".user-skills") },
    rediscoveryIntervalMs: null,
    triggerTickIntervalMs: null,
  });
  try {
    const dataDir = seededDataDir();
    await _scheduleItemReconcileForTesting(asCollection("tasks", dataDir), "t1");
    assert.deepEqual(published, [{ slug: "tasks", ids: ["t1"], op: "upsert", root: projectRoot }]);
  } finally {
    await stopCollectionWatchers();
  }
});

test("starting a second watcher generation for a different root throws instead of leaving it unwatched", async () => {
  // This module holds one watcher generation per process. Before, the second
  // call hit `if (started) return` and root B was simply never watched — direct
  // file writes there emitted neither live-refresh events nor bells, silently.
  const rootOne = makeTempDir("cw-one-");
  const rootTwo = makeTempDir("cw-two-");
  await startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootOne }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  try {
    await assert.rejects(
      () => startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootTwo }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null }),
      /one watcher generation/,
    );
    // Same root stays idempotent — that is the production restart path.
    await assert.doesNotReject(() =>
      startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootOne }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null }),
    );
  } finally {
    await stopCollectionWatchers();
  }
});

test("two CONCURRENT starts for different roots cannot both boot", async () => {
  // `started` flips only after two awaits, so guarding on it alone let both
  // callers through: they overwrote each other's `discoveryOpts` mid-boot and
  // each armed an interval, the first of which then escaped teardown. The
  // generation claim has to be taken before the first await.
  const rootOne = makeTempDir("cw-race-a-");
  const rootTwo = makeTempDir("cw-race-b-");
  const settled = await Promise.allSettled([
    startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootOne }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null }),
    startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootTwo }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null }),
  ]);
  try {
    assert.equal(settled.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = settled.find((outcome) => outcome.status === "rejected");
    assert.match(String(rejected?.status === "rejected" ? rejected.reason : ""), /one watcher generation/);

    // The winner's root is the one payloads are stamped with — proof the loser
    // did not overwrite `discoveryOpts` on its way out.
    const dataDir = seededDataDir();
    await _scheduleItemReconcileForTesting(asCollection("tasks", dataDir), "t1");
    assert.equal(published.length, 1);
    assert.equal(published[0]?.root, rootOne);
  } finally {
    await stopCollectionWatchers();
  }
});

test("stop then start for a DIFFERENT root switches generations — the project-switch path", async () => {
  // This is how a multi-root host changes projects, and therefore the path that
  // matters most: refusing the second start is only safe if the supported
  // alternative actually works. `stopCollectionWatchers` is a production API
  // for that host, not a test-only helper.
  const rootOne = makeTempDir("cw-switch-a-");
  const rootTwo = makeTempDir("cw-switch-b-");
  await startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootOne }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  await stopCollectionWatchers();
  await startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootTwo }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  try {
    const dataDir = seededDataDir();
    await _scheduleItemReconcileForTesting(asCollection("tasks", dataDir), "t1");
    assert.deepEqual(published, [{ slug: "tasks", ids: ["t1"], op: "upsert", root: rootTwo }]);
  } finally {
    await stopCollectionWatchers();
  }
});

test("naming the host's own configured root explicitly is the same generation, not a conflict", async () => {
  // `start()` and `start({ workspaceRoot: <the host default> })` mean the same
  // thing. Comparing the raw option would have called them different roots and
  // thrown at a host that merely became explicit about what it already had.
  await startCollectionWatchers({ rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  try {
    await assert.doesNotReject(() =>
      startCollectionWatchers({ discoveryOpts: { workspaceRoot: root }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null }),
    );
    await assert.rejects(
      () => startCollectionWatchers({ discoveryOpts: { workspaceRoot: makeTempDir("cw-other-") }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null }),
      (err: unknown) => (err as { code?: string }).code === WATCHER_ROOT_CONFLICT,
    );
  } finally {
    await stopCollectionWatchers();
  }
});

test("the two root failures are told apart by code, not by message text", () => {
  // A host catches watcher startup in one fire-and-forget `.catch`, so both
  // land on the same log line. The fixes differ — stop the running generation
  // versus pass the missing option — so the codes have to differ too.
  assert.notEqual(WATCHER_ROOT_CONFLICT, COLLECTION_ROOT_REQUIRED);
});

test("a watcher started with no root override omits root, as a single-workspace host expects", async () => {
  await startCollectionWatchers({ rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  try {
    const dataDir = seededDataDir();
    await _scheduleItemReconcileForTesting(asCollection("tasks", dataDir), "t1");
    assert.deepEqual(published, [{ slug: "tasks", ids: ["t1"], op: "upsert" }]);
  } finally {
    await stopCollectionWatchers();
  }
});
