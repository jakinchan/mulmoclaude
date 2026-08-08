// The multi-root contract (plans/feat-collection-multi-root.md).
//
// MulmoClaude has one workspace, so an engine call that reads the ambient root
// looks correct there forever. MulmoTerminal serves N project roots off one
// process: there the same call does not crash — it reads or writes the WRONG
// project, silently. These tests are the ones the single-root architecture
// could not express.
//
// The host here is bound in EXPLICIT-ROOT mode (`workspaceRoot: null`), which
// is what makes the isolation assertions total rather than sampled: there is no
// ambient root to fall back TO, so any entry point that ignored its explicit
// root throws instead of quietly hitting a shared workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  configureCollectionHost,
  discoverCollections,
  loadCollection,
  setCollectionChangePublisher,
  getWorkspaceRoot,
  writeItem,
  deleteItem,
  listItems,
  type CollectionChangePayload,
} from "../../src/collection/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

configureCollectionHost({
  workspaceRoot: null,
  log: noopLog,
  paths: {
    userSkillsDir: path.join(makeTempDir("mr-user-skills-"), "empty"),
    projectSkillsDir: (root) => path.join(root, ".claude", "skills"),
    feedsRoot: (root) => path.join(root, "data", "feeds"),
    skillsStagingDir: (root) => path.join(root, "data", "skills"),
    archiveDir: "data/archive",
    collectionsRegistriesConfig: (root) => path.join(root, "config", "collections-registries.json"),
  },
  isPresetSlug: () => false,
});

/** A project root with one `tasks` collection plus a root-specific second one,
 *  so "did the other root's discovery leak in?" is answerable by slug alone. */
function makeRoot(prefix: string, extraSlug: string): string {
  const root = makeTempDir(prefix);
  for (const slug of ["tasks", extraSlug]) {
    const skillDir = path.join(root, ".claude", "skills", slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "schema.json"),
      JSON.stringify({
        title: slug,
        icon: "list",
        primaryKey: "id",
        dataPath: `data/${slug}`,
        fields: { id: { type: "string", label: "Id", primary: true }, name: { type: "string", label: "Name" } },
      }),
    );
  }
  return root;
}

const rootA = makeRoot("mr-a-", "only-in-a");
const rootB = makeRoot("mr-b-", "only-in-b");
const published: CollectionChangePayload[] = [];
setCollectionChangePublisher((payload) => published.push(payload));

test("explicit-root mode: the ambient root is a loud throw, not a guess", () => {
  assert.throws(() => getWorkspaceRoot(), /explicit-root mode/);
});

test("an engine call with no explicit root throws instead of touching another project", async () => {
  await assert.rejects(() => discoverCollections(), /explicit-root mode/);
  await assert.rejects(() => loadCollection("tasks"), /explicit-root mode/);
  await assert.rejects(() => writeItem(path.join(rootA, "data", "tasks"), "t1", { id: "t1" }), /explicit-root mode/);
});

test("discovery under two roots sees each project's own collections and nothing of the other's", async () => {
  const inA = await discoverCollections({ workspaceRoot: rootA });
  const inB = await discoverCollections({ workspaceRoot: rootB });

  assert.deepEqual(
    inA.map((entry) => entry.slug),
    ["only-in-a", "tasks"],
  );
  assert.deepEqual(
    inB.map((entry) => entry.slug),
    ["only-in-b", "tasks"],
  );
  // The same slug in both roots must resolve to different dataDirs — a `tasks`
  // that resolved against one shared root is the whole bug this pins.
  const dataDirA = inA.find((entry) => entry.slug === "tasks")?.dataDir ?? "";
  const dataDirB = inB.find((entry) => entry.slug === "tasks")?.dataDir ?? "";
  assert.equal(dataDirA, path.join(rootA, "data", "tasks"));
  assert.equal(dataDirB, path.join(rootB, "data", "tasks"));
});

test("loadCollection resolves the slug within the root it was given", async () => {
  assert.equal((await loadCollection("only-in-a", { workspaceRoot: rootA }))?.slug, "only-in-a");
  assert.equal(await loadCollection("only-in-a", { workspaceRoot: rootB }), null);
  assert.equal(await loadCollection("only-in-b", { workspaceRoot: rootA }), null);
});

test("writes under two roots stay in their own root and publish their own root", async () => {
  published.length = 0;
  const dirA = path.join(rootA, "data", "tasks");
  const dirB = path.join(rootB, "data", "tasks");

  await writeItem(dirA, "shared-id", { id: "shared-id", name: "from A" }, { workspaceRoot: rootA, slug: "tasks" });
  await writeItem(dirB, "shared-id", { id: "shared-id", name: "from B" }, { workspaceRoot: rootB, slug: "tasks" });

  // U1: the change payload carries the root, so a host fanning out live updates
  // can key on (root, slug) instead of refreshing every project's `tasks`.
  assert.deepEqual(published, [
    { slug: "tasks", ids: ["shared-id"], op: "upsert", root: rootA },
    { slug: "tasks", ids: ["shared-id"], op: "upsert", root: rootB },
  ]);

  const itemsA = await listItems(dirA, { workspaceRoot: rootA });
  const itemsB = await listItems(dirB, { workspaceRoot: rootB });
  assert.deepEqual(
    itemsA.map((item) => item.name),
    ["from A"],
  );
  assert.deepEqual(
    itemsB.map((item) => item.name),
    ["from B"],
  );
});

test("a delete under one root leaves the same id in the other root alone", async () => {
  published.length = 0;
  const dirA = path.join(rootA, "data", "tasks");
  const dirB = path.join(rootB, "data", "tasks");

  const result = await deleteItem(dirA, "shared-id", { workspaceRoot: rootA, slug: "tasks" });
  assert.equal(result.kind, "ok");
  assert.deepEqual(published, [{ slug: "tasks", ids: ["shared-id"], op: "delete", root: rootA }]);

  assert.deepEqual(await listItems(dirA, { workspaceRoot: rootA }), []);
  assert.equal((await listItems(dirB, { workspaceRoot: rootB })).length, 1);
});

test("a write refuses a dataDir that belongs to the OTHER root", async () => {
  published.length = 0;
  // rootB's data dir is outside rootA — containment is checked against the root
  // the call was given, so this must be refused rather than written.
  const result = await writeItem(path.join(rootB, "data", "tasks"), "cross", { id: "cross" }, { workspaceRoot: rootA, slug: "tasks" });
  assert.equal(result.kind, "path-escape");
  assert.deepEqual(published, []);
  assert.equal(readdirSync(path.join(rootB, "data", "tasks")).includes("cross.json"), false);
});
