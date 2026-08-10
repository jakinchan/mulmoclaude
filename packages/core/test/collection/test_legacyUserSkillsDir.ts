// The pre-3.3.0 host binding still works.
//
// `paths.userSkillsDir` became `(root) => string | null` so a multi-root host
// could declare a root with NO user scope. The bare `string` form is kept
// because a caret range floats across minors: a host pinned at `^3.2.0`
// installs 3.3.0 without touching its code, and a REQUIRED callable would turn
// that into a TypeError on its first discovery — a crash, not an opt-out.
//
// The binding under test is deliberately a plain string, as MulmoClaude's own
// `configure.ts` wrote it before this release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { configureCollectionHost, discoverCollections, loadCollection } from "../../src/collection/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

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
      fields: { id: { type: "string", label: "Id", primary: true } },
    }),
  );
}

const userSkillsRoot = makeTempDir("lu-user-skills-");
writeCollectionSkill(userSkillsRoot, "user-only", "User only");

// Two roots, because "this path, for EVERY root" is the whole reading of the
// legacy form — one root could pass while a second silently lost user scope.
const workspaceRoot = makeTempDir("lu-workspace-");
writeCollectionSkill(path.join(workspaceRoot, ".claude", "skills"), "notes", "Project notes");

const secondRoot = makeTempDir("lu-second-");
writeCollectionSkill(path.join(secondRoot, ".claude", "skills"), "other", "Other project");

configureCollectionHost({
  workspaceRoot,
  log: noopLog,
  paths: {
    // The 3.2.0 shape, verbatim.
    userSkillsDir: userSkillsRoot,
    projectSkillsDir: (root) => path.join(root, ".claude", "skills"),
    feedsRoot: (root) => path.join(root, "data", "feeds"),
    skillsStagingDir: () => null,
    archiveDir: "data/archive",
    collectionsRegistriesConfig: (root) => path.join(root, "config", "collections-registries.json"),
  },
  isPresetSlug: () => false,
});

test("a string userSkillsDir still merges user scope into every root — no crash, no silent opt-out", async () => {
  for (const [root, own] of [
    [workspaceRoot, "notes"],
    [secondRoot, "other"],
  ] as const) {
    const found = await discoverCollections({ workspaceRoot: root });
    assert.deepEqual(found.map((entry) => entry.slug).sort(), [own, "user-only"].sort());
    assert.equal((await loadCollection("user-only", { workspaceRoot: root }))?.source, "user");
  }
});
