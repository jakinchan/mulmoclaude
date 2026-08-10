// Shared host wiring for the feeds-engine tests. Importing this module wires the
// collection + feeds (+ notifier) host singletons. Each test file runs in its own
// process (node --test spawns one per file), so the module-load configuration is
// conflict-free.
//
// The engine takes the workspace root as an explicit argument in every test, so
// the hosts' default roots are placeholders. The agent-ingest worker runner is
// folded into `configureFeedsHost` in production (single-shot); tests vary it per
// case, so `spawnWorker` delegates to a swappable holder exposed via
// `setTestWorker`.

import { mkdir, writeFile } from "node:fs/promises";

import path from "node:path";
import { configureCollectionHost } from "../../src/collection/server/index.ts";
import { configureNotifier, setNotifierFilePaths } from "../../src/notifier/index.ts";
import { configureFeedsHost, type AgentWorkerRunner } from "../../src/feeds/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
const PLACEHOLDER_ROOT = "/feeds-test-placeholder";

const DEFAULT_RUNNER: AgentWorkerRunner = async () => ({ ok: false, error: "no test worker set" });
let currentRunner: AgentWorkerRunner = DEFAULT_RUNNER;

/** Swap the agent-ingest worker launcher the engine will call. */
export function setTestWorker(runner: AgentWorkerRunner): void {
  currentRunner = runner;
}

/** Per-test reset hook: point the notifier at a fresh temp store with a no-op
 *  pub-sub (so the agent-ingest failure-bell path can publish/clear without
 *  throwing) AND restore the worker runner to its default, so a test that omits
 *  `setTestWorker()` can't silently reuse the previous test's runner. */
export function resetNotifierForTest(): void {
  currentRunner = DEFAULT_RUNNER;
  const dir = makeTempDir("feeds-notifier-");
  configureNotifier({
    writeJson: async (filePath, data) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(data, null, 2));
    },
    publishEvent: () => {},
  });
  setNotifierFilePaths({ active: path.join(dir, "active.json"), history: path.join(dir, "history.json") });
}

configureCollectionHost({
  workspaceRoot: PLACEHOLDER_ROOT,
  log: noopLog,
  paths: {
    userSkillsDir: () => path.join(PLACEHOLDER_ROOT, ".user-skills"),
    projectSkillsDir: (root) => path.join(root, ".claude", "skills"),
    feedsRoot: (root) => path.join(root, "feeds"),
    skillsStagingDir: (root) => path.join(root, "data", "skills"),
    archiveDir: "data/archive",
    collectionsRegistriesConfig: (root) => path.join(root, "config", "collections-registries.json"),
  },
  isPresetSlug: () => false,
});

configureFeedsHost({
  workspaceRoot: PLACEHOLDER_ROOT,
  log: noopLog,
  writeFileAtomic: async (filePath, content) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  },
  spawnWorker: (args) => currentRunner(args),
});
