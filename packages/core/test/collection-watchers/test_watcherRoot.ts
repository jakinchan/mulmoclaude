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
  type CollectionChangePayload,
  type LoadedCollection,
} from "../../src/collection/server/index.ts";
import { configureNotifier, setNotifierFilePaths } from "../../src/notifier/index.ts";
import {
  configureCollectionWatchers,
  startCollectionWatchers,
  stopCollectionWatchers,
  _scheduleItemReconcileForTesting,
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
