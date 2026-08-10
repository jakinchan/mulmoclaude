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
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
import { writeImportedCollection } from "../../src/collection/registry/server/importWriter.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

configureCollectionHost({
  workspaceRoot: null,
  log: noopLog,
  paths: {
    userSkillsDir: () => null,
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

test("the archive's RESTORE.md tells a direct root to restore where it will actually be read", async () => {
  // The restore doc is what a user (or the agent) follows months later. Its
  // staged version says to recreate `data/skills/<slug>/` and let the bridge
  // hook mirror it — instructions that leave a direct root's collection
  // undiscoverable while the document claims it is restored.
  const root = makeRoot("ns-restore-", false);
  const collection = await loadCollection("tasks", { workspaceRoot: root });
  assert.ok(collection);
  const result = await deleteCollection(collection, { workspaceRoot: root, dateStamp: "2026-01-01" });
  assert.equal(result.kind, "ok");

  const restore = readFileSync(path.join(root, result.kind === "ok" ? result.archivePath : "", "RESTORE.md"), "utf-8");
  assert.match(restore, /Recreate the skill files in `\.claude\/skills\/tasks\/`/);
  assert.doesNotMatch(restore, /Recreate the skill files in `data\/skills/);
  assert.match(restore, /Do\s+NOT restore into `data\/skills\/tasks\/`/, "and it must say so, since the staged habit is the default one");
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

// --- registry import -------------------------------------------------------
//
// The import writer installs into `data/skills/<slug>/` and mirrors the
// allowlist across. Under a null-staging root that mirror is the ONLY thing
// making the collection discoverable, and everything it does not carry — the
// `.origin.json` provenance, `views/*.html` — is stranded in a tree that reads
// and deletes now deliberately ignore. Update could not find the install, and
// delete would leave it behind.

const IMPORT_SCHEMA = {
  title: "Imported",
  icon: "list",
  primaryKey: "id",
  dataPath: "data/imported/items",
  fields: { id: { type: "string", label: "Id", primary: true } },
  views: [{ id: "board", label: "Board", file: "views/board.html", capabilities: ["read"] }],
};

const bundleFor = (): Map<string, string> =>
  new Map([
    ["SKILL.md", "---\nname: imported\ndescription: an imported collection\n---\n\nbody\n"],
    ["schema.json", JSON.stringify(IMPORT_SCHEMA)],
    ["views/board.html", "<p>imported view</p>"],
  ]);

const IMPORT_ENTRY = {
  slug: "imported",
  author: "someone",
  version: "1.0.0",
  contentSha: "sha-1",
  title: "Imported",
} as never;

test("an import into a null-staging root installs in the skill dir, with its views and provenance", async () => {
  const root = makeTempDir("ns-import-");
  const result = await writeImportedCollection({
    registry: "https://example.test/registry.json",
    entry: IMPORT_ENTRY,
    bundle: bundleFor(),
    workspaceRoot: root,
    nowIso: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(result.ok, true, `import failed: ${JSON.stringify(result)}`);

  const skillDir = path.join(root, ".claude", "skills", "imported");
  assert.equal(existsSync(path.join(skillDir, "schema.json")), true);
  // The two the mirror would have left behind in an orphaned staging tree.
  assert.equal(existsSync(path.join(skillDir, "views", "board.html")), true, "views must land where reads look");
  assert.equal(existsSync(path.join(skillDir, ".origin.json")), true, "provenance must land where update looks");
  assert.equal(existsSync(path.join(root, "data", "skills")), false, "nothing may be written to a staging tree that does not exist here");

  const collection = await loadCollection("imported", { workspaceRoot: root });
  assert.ok(collection);
  assert.equal(await readCustomViewHtml(collection, "views/board.html", { workspaceRoot: root }), "<p>imported view</p>");
});

test("re-importing the same entry updates the install in place rather than renaming around it", async () => {
  const root = makeTempDir("ns-reimport-");
  const params = {
    registry: "https://example.test/registry.json",
    entry: IMPORT_ENTRY,
    workspaceRoot: root,
    nowIso: "2026-01-01T00:00:00.000Z",
  };
  assert.equal((await writeImportedCollection({ ...params, bundle: bundleFor() })).ok, true);
  const second = await writeImportedCollection({ ...params, bundle: bundleFor() });
  assert.equal(second.ok, true);
  // `imported-2` would mean the provenance was not found — the failure mode of
  // installing where discovery does not read.
  assert.deepEqual(
    (await discoverCollections({ workspaceRoot: root })).map((entry) => entry.slug),
    ["imported"],
  );
});

test("deleting an imported collection leaves nothing behind in a null-staging root", async () => {
  const root = makeTempDir("ns-import-del-");
  assert.equal(
    (
      await writeImportedCollection({
        registry: "https://example.test/registry.json",
        entry: IMPORT_ENTRY,
        bundle: bundleFor(),
        workspaceRoot: root,
        nowIso: "2026-01-01T00:00:00.000Z",
      })
    ).ok,
    true,
  );
  const collection = await loadCollection("imported", { workspaceRoot: root });
  assert.ok(collection);
  await deleteCollection(collection, { workspaceRoot: root, dateStamp: "2026-01-01" });
  assert.equal(existsSync(path.join(root, ".claude", "skills", "imported")), false);
  assert.deepEqual(await discoverCollections({ workspaceRoot: root }), []);
});
