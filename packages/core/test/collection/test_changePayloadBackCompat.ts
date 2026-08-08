// Back-compat pin for the multi-root change (U1). A single-workspace host —
// MulmoClaude — passes a string root and no per-call override, and its change
// payload must stay byte-identical to the pre-multi-root shape: `root` absent,
// not `root: <the configured workspace>`. Consumers deep-compare these payloads
// and a host that never sees more than one root has no use for the field.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  configureCollectionHost,
  setCollectionChangePublisher,
  storeFor,
  writeItem,
  deleteItem,
  type CollectionChangePayload,
  type LoadedCollection,
} from "../../src/collection/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
const root = makeTempDir("cp-bc-");

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

const published: CollectionChangePayload[] = [];
setCollectionChangePublisher((payload) => published.push(payload));
const dataDir = path.join(root, "data", "tasks");

test("a write with no explicit root publishes the pre-multi-root payload, root absent", async () => {
  published.length = 0;
  await writeItem(dataDir, "t1", { id: "t1", name: "Pending" }, { slug: "tasks" });
  // deepEqual is deepSTRICTEqual here: an own `root: undefined` key would fail
  // this, which is the point — the field must not appear at all.
  assert.deepEqual(published, [{ slug: "tasks", ids: ["t1"], op: "upsert" }]);
  assert.equal(Object.hasOwn(published[0] ?? {}, "root"), false);
});

test("a delete with no explicit root likewise omits root", async () => {
  published.length = 0;
  const result = await deleteItem(dataDir, "t1", { slug: "tasks" });
  assert.equal(result.kind, "ok");
  assert.deepEqual(published, [{ slug: "tasks", ids: ["t1"], op: "delete" }]);
});

test("the sqlite store with no explicit root omits it, and stamps it when given one", async () => {
  const collection = {
    slug: "sqlite-tasks",
    source: "project",
    schema: { primaryKey: "id", title: "Sqlite", icon: "db", storage: { type: "sqlite", path: "data/sqlite-tasks/records.db" } },
    dataDir: path.join(root, "data", "sqlite-tasks"),
    skillDir: path.join(root, ".claude", "skills", "sqlite-tasks"),
    storageFile: path.join(root, "data", "sqlite-tasks", "records.db"),
  } as unknown as LoadedCollection;

  published.length = 0;
  await storeFor(collection, {}).write?.("s1", { id: "s1" });
  assert.deepEqual(published, [{ slug: "sqlite-tasks", ids: ["s1"], op: "upsert" }]);

  published.length = 0;
  await storeFor(collection, { workspaceRoot: root }).delete?.("s1");
  assert.deepEqual(published, [{ slug: "sqlite-tasks", ids: ["s1"], op: "delete", root }]);
});

test("the same host still stamps root when a call passes one explicitly", async () => {
  published.length = 0;
  await writeItem(dataDir, "t2", { id: "t2" }, { slug: "tasks", workspaceRoot: root });
  assert.deepEqual(published, [{ slug: "tasks", ids: ["t2"], op: "upsert", root }]);
});
