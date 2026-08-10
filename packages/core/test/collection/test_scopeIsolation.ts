// Scope isolation (plans/feat-collection-scope-isolation.md).
//
// A host with more than one root can declare that a root has NO user scope
// (`paths.userSkillsDir` → null): `~` and a project are separate worlds, so a
// collection under `~/.claude/skills` must be unreachable from a project root —
// not listed, and not RESOLVABLE by slug.
//
// The resolvable half is the point. A host-side filter on the listing leaves
// `loadCollection` intact, and that is what getSchema / getItems / putItems /
// the detail route / the view-token mint / the watcher all go through — so a
// slug typed by the agent, or arriving in a URL, would still resolve to the
// user-scope collection and write into its data dir. These tests assert the
// miss, which a listing filter could not deliver.
//
// The same host binds a workspace root to a real path, so the merged behaviour
// MulmoClaude depends on (user scope visible, project shadowing user) is pinned
// in the same file as the isolation it must not become.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { configureCollectionHost, discoverCollections, loadCollection, makeManageCollectionTool } from "../../src/collection/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

/** Write a minimal per-file collection skill under `<skillsRoot>/<slug>`. */
function writeCollectionSkill(skillsRoot: string, slug: string, title: string): void {
  const skillDir = path.join(skillsRoot, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "schema.json"),
    JSON.stringify({
      title,
      icon: "list",
      primaryKey: "id",
      dataPath: `data/${slug}`,
      fields: { id: { type: "string", label: "Id", primary: true }, name: { type: "string", label: "Name" } },
    }),
  );
}

// One machine-global user scope, holding a slug that exists NOWHERE else
// (`user-only`) plus a `tasks` the workspace root also has — the collision the
// merged world resolves and the isolated one never sees.
const userSkillsRoot = makeTempDir("si-user-skills-");
writeCollectionSkill(userSkillsRoot, "user-only", "User only");
writeCollectionSkill(userSkillsRoot, "tasks", "User tasks");

// The managed workspace: user scope merges into it, exactly as today.
const workspaceRoot = makeTempDir("si-workspace-");
writeCollectionSkill(path.join(workspaceRoot, ".claude", "skills"), "tasks", "Workspace tasks");

// A plain project directory: separate world, no user scope.
const projectRoot = makeTempDir("si-project-");
writeCollectionSkill(path.join(projectRoot, ".claude", "skills"), "notes", "Project notes");

configureCollectionHost({
  // Explicit-root mode, so nothing can fall back to an ambient root and pass
  // an isolation assertion by accident.
  workspaceRoot: null,
  log: noopLog,
  paths: {
    // The multi-root answer the plan asks for, in the one-line shape a host
    // writes it: a managed workspace has user scope, a project root does not.
    userSkillsDir: (root) => (root === workspaceRoot ? userSkillsRoot : null),
    projectSkillsDir: (root) => path.join(root, ".claude", "skills"),
    feedsRoot: (root) => path.join(root, "data", "feeds"),
    skillsStagingDir: () => null,
    archiveDir: "data/archive",
    collectionsRegistriesConfig: (root) => path.join(root, "config", "collections-registries.json"),
  },
  isPresetSlug: () => false,
});

const slugsIn = async (root: string): Promise<string[]> => (await discoverCollections({ workspaceRoot: root })).map((entry) => entry.slug);

test("a project root lists only its own collections — the user scope is not merged in", async () => {
  assert.deepEqual(await slugsIn(projectRoot), ["notes"]);
});

test("a project root MISSES a user-only slug instead of hopping into another world", async () => {
  // The assertion a listing filter could not make: resolution itself refuses.
  assert.equal(await loadCollection("user-only", { workspaceRoot: projectRoot }), null);
  // And the slug the two worlds share resolves to nothing here either — this
  // root simply has no `tasks`.
  assert.equal(await loadCollection("tasks", { workspaceRoot: projectRoot }), null);
});

test("a workspace root still merges user scope, and its own collection still shadows a user one", async () => {
  assert.deepEqual(await slugsIn(workspaceRoot), ["tasks", "user-only"]);

  const shadowed = await loadCollection("tasks", { workspaceRoot });
  assert.equal(shadowed?.source, "project");
  assert.equal(shadowed?.schema.title, "Workspace tasks");

  const userScoped = await loadCollection("user-only", { workspaceRoot });
  assert.equal(userScoped?.source, "user");
  assert.equal(userScoped?.skillDir, path.join(userSkillsRoot, "user-only"));
});

test("an explicit `userSkillsDir: null` switches the scope off for one call, and `undefined` asks the host", async () => {
  // `??` could not express this: `undefined` there means "ask the host", so a
  // caller that passed null to opt OUT would have been silently opted back in.
  assert.equal(await loadCollection("user-only", { workspaceRoot, userSkillsDir: null }), null);
  assert.deepEqual(await slugsIn(workspaceRoot), ["tasks", "user-only"]);
  assert.equal((await loadCollection("user-only", { workspaceRoot, userSkillsDir: undefined }))?.source, "user");
});

test("putSchema / putItems for a user-only slug fail as unknown from a project root, writing nothing into the user scope", async () => {
  const tool = makeManageCollectionTool({ workspaceRoot: projectRoot, stagedSkillAuthoring: false });
  const schemaFile = path.join(userSkillsRoot, "user-only", "schema.json");
  const before = readFileSync(schemaFile, "utf-8");

  const putSchema = await tool.handler({
    action: "putSchema",
    slug: "user-only",
    schema: { title: "Hijacked", icon: "list", primaryKey: "id", dataPath: "data/user-only", fields: { id: { type: "string", label: "Id", primary: true } } },
  });
  assert.match(putSchema, /unknown collection 'user-only'/);

  const putItems = await tool.handler({ action: "putItems", slug: "user-only", items: [{ id: "x1", name: "from the project" }] });
  assert.match(putItems, /unknown collection 'user-only'/);

  // The user scope is untouched: same schema, and no record dir conjured under it.
  assert.equal(readFileSync(schemaFile, "utf-8"), before);
  assert.deepEqual(readdirSync(path.join(userSkillsRoot, "user-only")), ["schema.json"]);
  assert.equal(existsSync(path.join(projectRoot, "data", "user-only")), false);
});
