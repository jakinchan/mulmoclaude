// `stagedSkillAuthoring` and `skillsStagingDir` both describe where a
// collection skill is authored in this root, and either can be set without the
// other. If they are read separately the tool contradicts its own
// documentation: the agent is told to write `.claude/skills/<slug>/` while
// `putSchema` writes `data/skills/` and mirrors from there — or the reverse.
//
// So one predicate governs both, and staged requires BOTH to agree. These tests
// walk all four combinations against a real tmpdir root and assert that the
// guide `schemaDocs` serves names the directory `putSchema` actually wrote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { configureCollectionHost, makeManageCollectionTool, type ManageCollectionDeps } from "../../src/collection/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

/** Flipped per test before the tool is called; the host binding is a
 *  process-level singleton, so the switch has to live behind it. */
let stagingEnabled = true;

configureCollectionHost({
  workspaceRoot: null,
  log: noopLog,
  paths: {
    userSkillsDir: () => null,
    projectSkillsDir: (root) => path.join(root, ".claude", "skills"),
    feedsRoot: (root) => path.join(root, "data", "feeds"),
    skillsStagingDir: (root) => (stagingEnabled ? path.join(root, "data", "skills") : null),
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
};

/** A root whose `tasks` collection exists in BOTH trees, so neither location
 *  wins by being the only one present — the assertion is about which one the
 *  tool CHOSE, not which one happened to exist. */
function makeRoot(prefix: string): string {
  const root = makeTempDir(prefix);
  for (const dir of [path.join(root, ".claude", "skills", "tasks"), path.join(root, "data", "skills", "tasks")]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "schema.json"), JSON.stringify(SCHEMA));
  }
  return root;
}

const bundledHelps = (): string => path.join(import.meta.dirname, "..", "..", "assets", "helps");

async function run(root: string, staged: boolean | undefined, args: Record<string, unknown>): Promise<string> {
  const deps: ManageCollectionDeps = { workspaceRoot: root, bundledHelpsDir: bundledHelps, ...(staged === undefined ? {} : { stagedSkillAuthoring: staged }) };
  return makeManageCollectionTool(deps).handler(args);
}

/** Which tree `putSchema` wrote, judged by the title it left behind. */
function wroteInto(root: string): { staging: boolean; active: boolean } {
  const titled = (dir: string): boolean => existsSync(dir) && String(JSON.parse(readFileSync(dir, "utf-8")).title) === "Renamed";
  return {
    staging: titled(path.join(root, "data", "skills", "tasks", "schema.json")),
    active: titled(path.join(root, ".claude", "skills", "tasks", "schema.json")),
  };
}

const renamed = { ...SCHEMA, title: "Renamed" };

/** The guide's own instruction line, which is what the agent acts on. */
const tellsAgentToUseStaging = (docs: string): boolean => /Author under `data\/skills\/<slug>\/`, NEVER/.test(docs);

test("staging present + flag unset: staged docs, staged write, mirrored (today's behaviour)", async () => {
  stagingEnabled = true;
  const root = makeRoot("ac-staged-");
  assert.equal(tellsAgentToUseStaging(await run(root, undefined, { action: "schemaDocs", topic: "anatomy" })), true);
  await run(root, undefined, { action: "putSchema", slug: "tasks", schema: renamed });
  assert.deepEqual(wroteInto(root), { staging: true, active: true }, "staging is canonical and the mirror follows");
});

test("staging absent: direct docs and a direct write, whatever the flag says", async () => {
  stagingEnabled = false;
  const root = makeRoot("ac-nostaging-");
  assert.equal(tellsAgentToUseStaging(await run(root, undefined, { action: "schemaDocs", topic: "anatomy" })), false);
  await run(root, undefined, { action: "putSchema", slug: "tasks", schema: renamed });
  assert.deepEqual(wroteInto(root), { staging: false, active: true });
});

test("flag false while staging exists: direct docs AND a direct write — they cannot disagree", async () => {
  // The combination that used to contradict itself: the agent was told to
  // author under `.claude/skills/` while putSchema wrote `data/skills/` and
  // mirrored from there, so the tool documented one location and used another.
  stagingEnabled = true;
  const root = makeRoot("ac-flagfalse-");
  assert.equal(tellsAgentToUseStaging(await run(root, false, { action: "schemaDocs", topic: "anatomy" })), false);
  await run(root, false, { action: "putSchema", slug: "tasks", schema: renamed });
  assert.deepEqual(wroteInto(root), { staging: false, active: true }, "the write must follow the guide the agent was given");
});

test("getSchema reads the same copy putSchema wrote, in every combination", async () => {
  for (const [label, staging, flag] of [
    ["staged", true, undefined],
    ["no staging tree", false, undefined],
    ["flag off", true, false],
  ] as const) {
    stagingEnabled = staging;
    const root = makeRoot(`ac-rt-${label.replace(/\s+/g, "-")}-`);
    await run(root, flag, { action: "putSchema", slug: "tasks", schema: renamed });
    const read = JSON.parse(await run(root, flag, { action: "getSchema", slug: "tasks" }));
    assert.equal(read.title, "Renamed", `${label}: getSchema must not return a stale copy from the other tree`);
  }
});

test("the create-it-here message names the directory this root actually reads", async () => {
  // An error string is acted on immediately, so naming `data/skills/` under a
  // root with no staging tree sends the agent to a directory nothing reads —
  // the same silent failure the root-aware guide exists to prevent.
  stagingEnabled = false;
  const root = makeRoot("ac-msg-direct-");
  const message = await run(root, undefined, { action: "putSchema", slug: "nope", schema: renamed });
  assert.match(message, /under \.claude\/skills\/nope\//);
  assert.doesNotMatch(message, /data\/skills/);

  stagingEnabled = true;
  const staged = makeRoot("ac-msg-staged-");
  const stagedMessage = await run(staged, undefined, { action: "putSchema", slug: "nope", schema: renamed });
  assert.match(stagedMessage, /under data\/skills\/nope\//);
});
