// Focused coverage of the package's host-injection seam: a custom
// CollectionNotificationAdapter + the shared ../../src/notifier/index.ts
// singleton drive reconcileItem through publish / severity-update / clear,
// proving the adapter wiring without MulmoClaude's legacy machinery. (The
// full convergent-reconcile + watcher behaviour is exercised by the host's
// 46 collection tests running against this package via its shims.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureCollectionHost } from "../../src/collection/server/index.ts";
import { configureNotifier, setNotifierFilePaths, listAll, type NotifierEvent } from "../../src/notifier/index.ts";
import {
  configureCollectionWatchers,
  reconcileItem,
  itemIsDone,
  resolveDisplayLabel,
  type CollectionNotificationAdapter,
} from "../../src/collection-watchers/index.ts";
import type { LoadedCollection } from "../../src/collection/server/index.ts";

// The store-based reconciler takes the discovered collection.
const asCollection = (slug: string, schema: unknown, dataDir: string): LoadedCollection =>
  ({ slug, source: "project", schema, dataDir, skillDir: dataDir }) as unknown as LoadedCollection;

const root = mkdtempSync(path.join(tmpdir(), "cw-root-"));
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

const events: NotifierEvent[] = [];
configureNotifier({
  writeJson: async (filePath, data) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2));
  },
  publishEvent: (event) => events.push(event),
});

// The adapter under test: a non-MulmoClaude taxonomy/routing, so a pass
// proves the seam is real (not the legacy machinery leaking through).
const adapter: CollectionNotificationAdapter = {
  pluginPkg: "test-bells",
  priorityToSeverity: (prio) => (prio === "high" ? "urgent" : "nudge"),
  buildNavigateTarget: (slug, itemId) => `/x/${slug}/${itemId}`,
  buildPluginData: ({ legacyId, priority }) => ({ kind: "cw", legacyId, priority }),
  readEntry: (pluginData) => {
    if (typeof pluginData !== "object" || pluginData === null) return null;
    const rec = pluginData as Record<string, unknown>;
    if (rec.kind !== "cw" || typeof rec.legacyId !== "string") return null;
    return { legacyId: rec.legacyId, priority: rec.priority === "high" ? "high" : "normal" };
  },
};
configureCollectionWatchers({ adapter });

const SCHEMA = { primaryKey: "id", title: "Tasks", displayField: "name", completionField: "done", completionDoneValues: ["true"] } as never;

function freshNotifierFiles(): void {
  const dir = mkdtempSync(path.join(root, "notif-"));
  setNotifierFilePaths({ active: path.join(dir, "active.json"), history: path.join(dir, "history.json") });
  events.length = 0;
}

function dataDirWith(records: Record<string, unknown>[]): string {
  const dir = mkdtempSync(path.join(root, "coll-"));
  mkdirSync(dir, { recursive: true });
  for (const rec of records) writeFileSync(path.join(dir, `${rec.id as string}.json`), JSON.stringify(rec));
  return dir;
}

test("pure helpers: itemIsDone + resolveDisplayLabel", () => {
  assert.equal(itemIsDone(SCHEMA, { id: "a", done: "true" }), true);
  assert.equal(itemIsDone(SCHEMA, { id: "a", done: "false" }), false);
  assert.equal(resolveDisplayLabel(SCHEMA, { id: "a", name: "Buy milk" }, "a"), "Buy milk");
  assert.equal(resolveDisplayLabel(SCHEMA, { id: "a" }, "a"), "a"); // falls back to itemId
});

test("itemIsDone re-export stays flag-aware (completionField naming a flag field)", () => {
  const flagSchema = {
    fields: {
      status: { type: "enum", label: "Status", values: ["todo", "done"] },
      isDone: { type: "flag", label: "Done", where: [{ field: "status", op: "in", value: ["done"] }] },
    },
    completionField: "isDone",
  } as unknown as typeof SCHEMA;
  assert.equal(itemIsDone(flagSchema, { id: "a", status: "done" }), true);
  assert.equal(itemIsDone(flagSchema, { id: "a", status: "todo" }), false);
});

test("reconcileItem publishes a bell for a pending record via the adapter", async () => {
  freshNotifierFiles();
  const dataDir = dataDirWith([{ id: "t1", name: "Pending task", done: "false" }]);
  try {
    await reconcileItem(asCollection("todo", SCHEMA, dataDir), "t1", { workspaceRoot: root });
    const all = await listAll();
    assert.equal(all.length, 1);
    const [bell] = all;
    assert.ok(bell);
    assert.equal(bell.pluginPkg, "test-bells");
    assert.equal(bell.title, "Tasks: Pending task");
    assert.equal(bell.navigateTarget, "/x/todo/t1");
    assert.equal(bell.lifecycle, "action");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("reconcileItem is idempotent — re-running does not duplicate the bell", async () => {
  freshNotifierFiles();
  const dataDir = dataDirWith([{ id: "t1", name: "Pending", done: "false" }]);
  try {
    await reconcileItem(asCollection("todo", SCHEMA, dataDir), "t1", { workspaceRoot: root });
    await reconcileItem(asCollection("todo", SCHEMA, dataDir), "t1", { workspaceRoot: root });
    assert.equal((await listAll()).length, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("reconcileItem clears the bell when the record becomes done", async () => {
  freshNotifierFiles();
  const dataDir = dataDirWith([{ id: "t1", name: "Task", done: "false" }]);
  try {
    await reconcileItem(asCollection("todo", SCHEMA, dataDir), "t1", { workspaceRoot: root });
    assert.equal((await listAll()).length, 1);
    writeFileSync(path.join(dataDir, "t1.json"), JSON.stringify({ id: "t1", name: "Task", done: "true" }));
    await reconcileItem(asCollection("todo", SCHEMA, dataDir), "t1", { workspaceRoot: root });
    assert.equal((await listAll()).length, 0);
    assert.deepEqual(
      events.map((event) => event.type),
      ["published", "cleared"],
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("reconcileItem clears the bell when the record file is deleted", async () => {
  freshNotifierFiles();
  const dataDir = dataDirWith([{ id: "t1", name: "Task", done: "false" }]);
  try {
    await reconcileItem(asCollection("todo", SCHEMA, dataDir), "t1", { workspaceRoot: root });
    assert.equal((await listAll()).length, 1);
    rmSync(path.join(dataDir, "t1.json"));
    await reconcileItem(asCollection("todo", SCHEMA, dataDir), "t1", { workspaceRoot: root });
    assert.equal((await listAll()).length, 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test.after(() => rmSync(root, { recursive: true, force: true }));
