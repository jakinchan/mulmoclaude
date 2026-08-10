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
import { clear as notifierClear, configureNotifier, listAll, setNotifierFilePaths } from "../../src/notifier/index.ts";
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
    userSkillsDir: (wsRoot) => path.join(wsRoot, ".user-skills"),
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

function seededDataDirIn(base: string): string {
  const dir = mkdtempSync(path.join(base, "coll-"));
  writeFileSync(path.join(dir, "t1.json"), JSON.stringify({ id: "t1", name: "Pending" }));
  published.length = 0;
  return dir;
}

const seededDataDir = (): string => seededDataDirIn(root);

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

test("two roots are watched at once, each stamping its OWN root — no bleed", async () => {
  // This used to throw: the module held one generation per process, so the
  // second root was either refused or (before that) silently unwatched. A
  // multi-root host needs both live at the same time, and neither may publish
  // under the other's root — two projects each owning a `tasks` collection
  // would otherwise refresh each other's open views.
  const rootOne = makeTempDir("cw-one-");
  const rootTwo = makeTempDir("cw-two-");
  await startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootOne }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  await startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootTwo }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  try {
    // Same root stays idempotent — that is the production restart path.
    await assert.doesNotReject(() =>
      startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootOne }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null }),
    );

    const dataDir = seededDataDir();
    await _scheduleItemReconcileForTesting(asCollection("tasks", dataDir), "t1", rootOne);
    await _scheduleItemReconcileForTesting(asCollection("tasks", dataDir), "t1", rootTwo);
    assert.deepEqual(
      published.map((payload) => payload.root),
      [rootOne, rootTwo],
    );

    // Stopping ONE root leaves the other running.
    await stopCollectionWatchers({ workspaceRoot: rootOne });
    published.length = 0;
    await _scheduleItemReconcileForTesting(asCollection("tasks", dataDir), "t1", rootTwo);
    assert.deepEqual(
      published.map((payload) => payload.root),
      [rootTwo],
    );
  } finally {
    await stopCollectionWatchers();
  }
});

test("lexically equivalent spellings of one root are ONE generation, not two", async () => {
  // `/work/proj` and `/work/proj/` are the same tree. Keyed on the raw string
  // they mount two watcher sets over it, so every direct write publishes twice
  // and every pending record bells twice — under two ids that can never clear
  // each other. The claim is canonicalised (`path.resolve`) for that reason.
  const projectRoot = makeTempDir("cw-canon-");
  await startCollectionWatchers({ discoveryOpts: { workspaceRoot: projectRoot }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  try {
    await startCollectionWatchers({ discoveryOpts: { workspaceRoot: `${projectRoot}/` }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
    await startCollectionWatchers({ discoveryOpts: { workspaceRoot: path.join(projectRoot, ".") }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });

    const dataDir = seededDataDirIn(projectRoot);
    await _scheduleItemReconcileForTesting(asCollection("tasks", dataDir), "t1", projectRoot);
    assert.deepEqual(published, [{ slug: "tasks", ids: ["t1"], op: "upsert", root: projectRoot }]);

    // And a stop naming the trailing-slash spelling tears down that same one.
    await stopCollectionWatchers({ workspaceRoot: `${projectRoot}/` });
    published.length = 0;
    await _scheduleItemReconcileForTesting(asCollection("tasks", dataDir), "t1", projectRoot);
    assert.deepEqual(published, [{ slug: "tasks", ids: ["t1"], op: "upsert" }], "the generation is gone, so the detached fallback publishes rootless");
  } finally {
    await stopCollectionWatchers();
  }
});

test("two roots' bells do not dedupe into each other", async () => {
  // The bell identity is what made concurrency unsafe before: `legacyId` was
  // `<slug>:<itemId>`, so root B's pending `tasks/t1` found root A's entry and
  // published nothing. Both apps read one notifier file, so this is a
  // cross-app contract, not an internal map.
  const rootOne = makeTempDir("cw-bell-a-");
  const rootTwo = makeTempDir("cw-bell-b-");
  // Records must live UNDER the root their generation runs for — the store's
  // containment check is what makes the two projects separate on disk.
  const dirOne = seededDataDirIn(rootOne);
  const dirTwo = seededDataDirIn(rootTwo);
  const bellSchema = { primaryKey: "id", title: "Tasks", displayField: "name", completionField: "done", completionDoneValues: ["yes"] } as never;
  const withBells = (dataDir: string): LoadedCollection =>
    ({ slug: "tasks", source: "project", schema: bellSchema, dataDir, skillDir: dataDir }) as unknown as LoadedCollection;
  await startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootOne }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  await startCollectionWatchers({ discoveryOpts: { workspaceRoot: rootTwo }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  try {
    await _scheduleItemReconcileForTesting(withBells(dirOne), "t1", rootOne);
    await _scheduleItemReconcileForTesting(withBells(dirTwo), "t1", rootTwo);
    const ids = (await listAll()).map((entry) => (entry.pluginData as { legacyId?: string }).legacyId);
    assert.equal(new Set(ids).size, 2, `expected two distinct bells, got ${JSON.stringify(ids)}`);
  } finally {
    await stopCollectionWatchers();
    for (const entry of await listAll()) await notifierClear(entry.id);
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

test("naming the host's own configured root explicitly is the same generation, not a second one", async () => {
  // `start()` and `start({ workspaceRoot: <the host default> })` mean the same
  // thing. Comparing the raw option would mount two watcher sets over one tree
  // and publish every change twice.
  await startCollectionWatchers({ rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
  try {
    await startCollectionWatchers({ discoveryOpts: { workspaceRoot: root }, rediscoveryIntervalMs: null, triggerTickIntervalMs: null });
    const dataDir = seededDataDir();
    await _scheduleItemReconcileForTesting(asCollection("tasks", dataDir), "t1");
    // One generation ⇒ one publish, and the FIRST start's root-less options win
    // (the payload carries no root, as a single-workspace host expects).
    assert.deepEqual(published, [{ slug: "tasks", ids: ["t1"], op: "upsert" }]);
  } finally {
    await stopCollectionWatchers();
  }
});

test("the two root codes stay distinct", () => {
  // `WATCHER_ROOT_CONFLICT` is no longer thrown — a second root now mounts a
  // second generation — but it stays exported for hosts that catch it, and it
  // must never collide with the "this call forgot its workspaceRoot" code.
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
