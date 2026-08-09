// `skillsStagingDir` may say "this root has no staging tree" (`null`), because
// staging only exists where a skill-bridge hook mirrors `data/skills/<slug>/`
// into `.claude/skills/`. A plain project root has no such hook, so its skill
// dir IS the authoring location.
//
// A host must NOT fake it by handing back the skill dir instead. It looks
// equivalent — the read list becomes the same dir twice — but the delete path
// `rm -rf`s the staging dir by name, so the committed skill would be removed
// under the label "staging". These tests pin the null path end to end, and pin
// the shadowing bug that made it necessary: an agent that followed the STAGED
// authoring instructions in a bridge-less root leaves a `data/skills/<slug>/`
// tree that must never win over the real skill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import {
  configureCollectionHost,
  discoverCollections,
  loadCollection,
  readCustomViewHtml,
  deleteCollection,
  writeItem,
  listItems,
} from "../../src/collection/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

configureCollectionHost({
  workspaceRoot: null,
  log: noopLog,
  paths: {
    userSkillsDir: path.join(makeTempDir("ns-user-skills-"), "empty"),
    projectSkillsDir: (root) => path.join(root, ".claude", "skills"),
    feedsRoot: (root) => path.join(root, "data", "feeds"),
    // The whole point: this root has no staging tree.
    skillsStagingDir: () => null,
    archiveDir: "data/archive",
    collectionsRegistriesConfig: (root) => path.join(root, "config", "collections-registries.json"),
  },
  isPresetSlug: () => false,
});

const SCHEMA = {
  title: "Tasks",
  icon: "list",
  primaryKey: "id",
  dataPath: "data/tasks",
  fields: { id: { type: "string", label: "Id", primary: true }, name: { type: "string", label: "Name" } },
  views: [{ id: "board", label: "Board", file: "views/board.html", capabilities: ["read"] }],
};

/** A project root whose `tasks` collection is committed under `.claude/skills`,
 *  with an optional stray staging tree left behind by an agent that followed
 *  the staged instructions here. */
function makeRoot(prefix: string, stray: boolean): string {
  const root = makeTempDir(prefix);
  const skillDir = path.join(root, ".claude", "skills", "tasks");
  mkdirSync(path.join(skillDir, "views"), { recursive: true });
  writeFileSync(path.join(skillDir, "schema.json"), JSON.stringify(SCHEMA));
  writeFileSync(path.join(skillDir, "views", "board.html"), "<p>committed</p>");
  if (stray) {
    const strayDir = path.join(root, "data", "skills", "tasks", "views");
    mkdirSync(strayDir, { recursive: true });
    writeFileSync(path.join(strayDir, "board.html"), "<p>stray</p>");
    writeFileSync(path.join(root, "data", "skills", "tasks", "schema.json"), JSON.stringify({ ...SCHEMA, title: "STRAY" }));
  }
  return root;
}

test("a null-staging root discovers, reads and writes its project collection", async () => {
  const root = makeRoot("ns-plain-", false);
  const found = await discoverCollections({ workspaceRoot: root });
  assert.deepEqual(
    found.map((entry) => entry.slug),
    ["tasks"],
  );
  const collection = await loadCollection("tasks", { workspaceRoot: root });
  assert.ok(collection);
  assert.equal(collection.skillDir, path.join(root, ".claude", "skills", "tasks"));

  await writeItem(collection.dataDir, "t1", { id: "t1", name: "One" }, { workspaceRoot: root });
  assert.deepEqual(await listItems(collection.dataDir, { workspaceRoot: root }), [{ id: "t1", name: "One" }]);

  assert.equal(await readCustomViewHtml(collection, "views/board.html", { workspaceRoot: root }), "<p>committed</p>");
});

test("a stray data/skills tree does NOT shadow the committed skill", async () => {
  // This is the exact residue the staged authoring instructions leave in a
  // bridge-less root. Reading staging first would serve `<p>stray</p>` forever,
  // with the real, version-controlled view never rendered.
  const root = makeRoot("ns-stray-", true);
  const collection = await loadCollection("tasks", { workspaceRoot: root });
  assert.ok(collection);
  assert.equal(collection.schema.title, "Tasks");
  assert.equal(await readCustomViewHtml(collection, "views/board.html", { workspaceRoot: root }), "<p>committed</p>");
});

test("delete removes the skill and the records — and never rm -rf's a phantom staging dir", async () => {
  const root = makeRoot("ns-del-", true);
  const collection = await loadCollection("tasks", { workspaceRoot: root });
  assert.ok(collection);
  await writeItem(collection.dataDir, "t1", { id: "t1", name: "One" }, { workspaceRoot: root });

  await deleteCollection(collection, { workspaceRoot: root, dateStamp: "2026-01-01" });

  assert.equal(existsSync(path.join(root, ".claude", "skills", "tasks")), false);
  assert.equal(existsSync(collection.dataDir), false);
  // The stray tree is not this collection's staging dir, so the delete leaves
  // it alone rather than reaching outside the locations it declared.
  assert.equal(existsSync(path.join(root, "data", "skills", "tasks")), true);
  assert.deepEqual(await discoverCollections({ workspaceRoot: root }), []);
});
