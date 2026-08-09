// A completion bell's identity is `(root, slug, itemId)`, but it is written to
// a file BOTH apps read (`<ws>/data/notifier/active.json`). So the rule is
// narrow: with no root the id must be byte-identical to the pre-multi-root
// format — otherwise a single-workspace host's existing entries stop matching
// and every pending record bells twice — and with a root it must differ, or two
// projects' `tasks/t1` dedupe into one bell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { configureCollectionHost, type LoadedCollection } from "../../src/collection/server/index.ts";
import { clear as notifierClear, configureNotifier, listAll, setNotifierFilePaths } from "../../src/notifier/index.ts";
import {
  configureCollectionWatchers,
  reconcileItem,
  clearItemNotification,
  sweepStaleActiveEntries,
  type CollectionNotificationAdapter,
} from "../../src/collection-watchers/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const root = makeTempDir("ci-root-");
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

/** A host's project-id table. The adapter resolves a root to an OPAQUE id and
 *  never puts the path itself in the target — a deep link ends up in URLs, and
 *  from there in tokens and iframes, so an absolute root would publish the
 *  user's home directory. The test asserts the opaque form for that reason. */
const projectIds = new Map<string, string>();
const projectId = (forRoot: string): string => {
  const existing = projectIds.get(forRoot);
  if (existing) return existing;
  const minted = `p${projectIds.size + 1}`;
  projectIds.set(forRoot, minted);
  return minted;
};

const navigateTargets: string[] = [];
/** What the adapter was handed, so the root can be asserted without requiring
 *  it to appear in the target. */
const navigateRoots: (string | undefined)[] = [];
const adapter: CollectionNotificationAdapter = {
  pluginPkg: "test-bells",
  priorityToSeverity: () => "nudge",
  buildNavigateTarget: (slug, itemId, entryRoot) => {
    navigateRoots.push(entryRoot);
    const target = entryRoot === undefined ? `/x/${slug}/${itemId}` : `/x/${projectId(entryRoot)}/${slug}/${itemId}`;
    navigateTargets.push(target);
    return target;
  },
  buildPluginData: ({ legacyId, root: entryRoot }) => ({ kind: "cw", legacyId, root: entryRoot }),
  readEntry: (pluginData) => {
    if (typeof pluginData !== "object" || pluginData === null) return null;
    const record = pluginData as Record<string, unknown>;
    return record.kind === "cw" && typeof record.legacyId === "string" ? { legacyId: record.legacyId, priority: "normal" } : null;
  },
};
configureCollectionWatchers({ adapter });

const SCHEMA = { primaryKey: "id", title: "Tasks", displayField: "name", completionField: "done", completionDoneValues: ["yes"] } as never;
const asCollection = (dataDir: string): LoadedCollection =>
  ({ slug: "tasks", source: "project", schema: SCHEMA, dataDir, skillDir: dataDir }) as unknown as LoadedCollection;

/** The rooted key shape, spelled out here rather than imported: it is a
 *  cross-app on-disk format, so the test states it independently of the code
 *  that builds it. */
const rootedId = (wsRoot: string): string => `collection-completion:@${wsRoot}\u0000tasks:t1`;

/** A fresh notifier file + a records dir under `base`, so each test starts from
 *  an empty bell and the store's containment check accepts the dataDir. */
function fixture(base: string): string {
  const dir = mkdtempSync(path.join(base, "coll-"));
  writeFileSync(path.join(dir, "t1.json"), JSON.stringify({ id: "t1", name: "Pending", done: "no" }));
  const notifDir = mkdtempSync(path.join(root, "notif-"));
  setNotifierFilePaths({ active: path.join(notifDir, "active.json"), history: path.join(notifDir, "history.json") });
  navigateTargets.length = 0;
  navigateRoots.length = 0;
  return dir;
}

const legacyIds = async (): Promise<string[]> => (await listAll()).map((entry) => String((entry.pluginData as { legacyId?: string }).legacyId));

test("with no root the legacyId and the navigate target are exactly what they always were", async () => {
  const dataDir = fixture(root);
  await reconcileItem(asCollection(dataDir), "t1");
  assert.deepEqual(await legacyIds(), ["collection-completion:tasks:t1"]);
  assert.deepEqual(navigateTargets, ["/x/tasks/t1"]);
  assert.deepEqual(navigateRoots, [undefined]);
});

test("with a root the id carries it, and the adapter is told which project to deep-link into", async () => {
  const projectRoot = makeTempDir("ci-proj-");
  const dataDir = fixture(projectRoot);
  await reconcileItem(asCollection(dataDir), "t1", { workspaceRoot: projectRoot });
  assert.deepEqual(await legacyIds(), [rootedId(projectRoot)]);
  // The adapter is told the root; the TARGET carries only the opaque id.
  assert.deepEqual(navigateRoots, [projectRoot]);
  assert.deepEqual(navigateTargets, [`/x/${projectId(projectRoot)}/tasks/t1`]);
  assert.ok(!(navigateTargets[0] ?? "").includes(projectRoot), "the absolute root must not appear in a deep link");
});

test("two roots, one slug, one itemId — two bells, not one", async () => {
  const rootOne = makeTempDir("ci-one-");
  const rootTwo = makeTempDir("ci-two-");
  const dirOne = fixture(rootOne);
  const dirTwo = mkdtempSync(path.join(rootTwo, "coll-"));
  writeFileSync(path.join(dirTwo, "t1.json"), JSON.stringify({ id: "t1", name: "Pending", done: "no" }));

  await reconcileItem(asCollection(dirOne), "t1", { workspaceRoot: rootOne });
  await reconcileItem(asCollection(dirTwo), "t1", { workspaceRoot: rootTwo });
  assert.equal(new Set(await legacyIds()).size, 2);

  // Clearing one leaves the other alone — the dedupe check and the clear path
  // must agree on the same key.
  await clearItemNotification("tasks", "t1", rootOne);
  assert.deepEqual(await legacyIds(), [rootedId(rootTwo)]);
});

test("a root-less clear does not touch a rooted entry", async () => {
  const projectRoot = makeTempDir("ci-mix-");
  const dataDir = fixture(root);
  const projectDir = mkdtempSync(path.join(projectRoot, "coll-"));
  writeFileSync(path.join(projectDir, "t1.json"), JSON.stringify({ id: "t1", name: "Pending", done: "no" }));

  await reconcileItem(asCollection(dataDir), "t1");
  await reconcileItem(asCollection(projectDir), "t1", { workspaceRoot: projectRoot });
  assert.equal((await listAll()).length, 2);

  await clearItemNotification("tasks", "t1");
  assert.deepEqual(await legacyIds(), [rootedId(projectRoot)]);
  for (const entry of await listAll()) await notifierClear(entry.id);
});

test("a rooted sweep clears LEGACY rootless entries instead of stranding them", async () => {
  // Upgrade path. A host that passes roots has entries in `active.json` written
  // before ids carried one. Nothing it does from now on produces a rootless id,
  // so skipping them as "another root's" would strand a bell that no pass can
  // ever clear — while the reconcile publishes a second, rooted one beside it.
  // Clearing converges: the record republishes rooted if it is still pending.
  const rootOne = makeTempDir("ci-legacy-a-");
  const rootTwo = makeTempDir("ci-legacy-b-");
  const legacyDir = fixture(root);
  const otherDir = mkdtempSync(path.join(rootTwo, "coll-"));
  writeFileSync(path.join(otherDir, "t1.json"), JSON.stringify({ id: "t1", name: "Pending", done: "no" }));

  await reconcileItem(asCollection(legacyDir), "t1"); // legacy: no root
  await reconcileItem(asCollection(otherDir), "t1", { workspaceRoot: rootTwo });
  assert.equal((await listAll()).length, 2);

  await sweepStaleActiveEntries({ workspaceRoot: rootOne });

  // The legacy entry is gone; the entry belonging to ANOTHER root is untouched,
  // because this sweep cannot see that tree and every check would read "gone".
  assert.deepEqual(await legacyIds(), [rootedId(rootTwo)]);
  for (const entry of await listAll()) await notifierClear(entry.id);
});

test("a rootless sweep leaves a ROOTED entry alone", async () => {
  // The mirror of the case above, and the one that protects a single-workspace
  // host: it sweeps with no root and must not clear a bell belonging to a
  // project it knows nothing about.
  const projectRoot = makeTempDir("ci-legacy-c-");
  fixture(root);
  const projectDir = mkdtempSync(path.join(projectRoot, "coll-"));
  writeFileSync(path.join(projectDir, "t1.json"), JSON.stringify({ id: "t1", name: "Pending", done: "no" }));

  await reconcileItem(asCollection(projectDir), "t1", { workspaceRoot: projectRoot });
  await sweepStaleActiveEntries({});
  assert.deepEqual(await legacyIds(), [rootedId(projectRoot)]);
  for (const entry of await listAll()) await notifierClear(entry.id);
});
