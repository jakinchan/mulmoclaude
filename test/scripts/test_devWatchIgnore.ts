import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDevWatchIgnore, devWatchIgnoredPrefixes, type DevWatchIgnoreOptions } from "../../scripts/lib/devWatchIgnore.js";
import { WORKSPACE_DIRS, WORKSPACE_FILES } from "../../server/workspace/paths.js";

const ROOT = "/home/dev/mulmoclaude";

const ignoreFor = (overrides: Partial<DevWatchIgnoreOptions> = {}) =>
  createDevWatchIgnore({ projectRoot: ROOT, workspacePath: "/home/dev/workspace", platform: "linux", ...overrides });

describe("createDevWatchIgnore — always-pruned paths", () => {
  it("prunes the server log directory", () => {
    const ignore = ignoreFor();
    assert.equal(ignore(`${ROOT}/server/system/logs/app.log`), true);
    assert.equal(ignore(`${ROOT}/server/system/logs`), true);
  });

  it("leaves ordinary source alone", () => {
    const ignore = ignoreFor();
    assert.equal(ignore(`${ROOT}/src/App.vue`), false);
    assert.equal(ignore(`${ROOT}/server/index.ts`), false);
    assert.equal(ignore(`${ROOT}/server/system/logsize.ts`), false);
  });
});

describe("createDevWatchIgnore — workspace outside the Vite root", () => {
  it("prunes nothing workspace-related", () => {
    const ignore = ignoreFor({ workspacePath: "/home/dev/workspace" });
    assert.equal(ignore("/home/dev/workspace/conversations/chat/a.jsonl"), false);
    assert.equal(ignore(`${ROOT}/conversations/chat/a.jsonl`), false);
  });

  it("treats a sibling sharing the root's string prefix as outside it", () => {
    assert.deepEqual(devWatchIgnoredPrefixes({ projectRoot: ROOT, workspacePath: `${ROOT}-workspace`, platform: "linux" }), [`${ROOT}/server/system/logs`]);
  });
});

describe("createDevWatchIgnore — workspace nested inside the Vite root", () => {
  it("prunes the whole workspace directory", () => {
    const ignore = ignoreFor({ workspacePath: `${ROOT}/ws` });
    assert.equal(ignore(`${ROOT}/ws/conversations/chat/a.jsonl`), true);
    assert.equal(ignore(`${ROOT}/ws/anything/at/all`), true);
    assert.equal(ignore(`${ROOT}/src/main.ts`), false);
  });
});

describe("createDevWatchIgnore — workspace IS the Vite root", () => {
  const ignore = ignoreFor({ workspacePath: ROOT });

  it("prunes the runtime data directories", () => {
    assert.equal(ignore(`${ROOT}/conversations/chat/a.jsonl`), true);
    assert.equal(ignore(`${ROOT}/data/scheduler/items.json`), true);
    assert.equal(ignore(`${ROOT}/artifacts/html/report.html`), true);
    assert.equal(ignore(`${ROOT}/feeds/hn/latest.json`), true);
    assert.equal(ignore(`${ROOT}/archive/2026/old.jsonl`), true);
    assert.equal(ignore(`${ROOT}/github/receptron/notes.md`), true);
    assert.equal(ignore(`${ROOT}/models/whisper/base.bin`), true);
    assert.equal(ignore(`${ROOT}/plugins/.cache/chart/1.0.0/index.js`), true);
    assert.equal(ignore(`${ROOT}/.mulmoclaude/mcp-abc.json`), true);
  });

  it("keeps watching .github, which is repo source and not the workspace's github/", () => {
    assert.equal(ignore(`${ROOT}/.github/workflows/pull_request.yaml`), false);
  });

  it("prunes the root sidecar files", () => {
    assert.equal(ignore(`${ROOT}/.session-token`), true);
    assert.equal(ignore(`${ROOT}/.server-port`), true);
  });

  it("keeps watching tracked repo directories that double as workspace dirs", () => {
    assert.equal(ignore(`${ROOT}/config/tsconfig.packages.json`), false);
    assert.equal(ignore(`${ROOT}/.claude/skills/foo/SKILL.md`), false);
  });

  it("matches whole segments only", () => {
    assert.equal(ignore(`${ROOT}/database/schema.ts`), false);
    assert.equal(ignore(`${ROOT}/src/data/table.ts`), false);
  });
});

describe("createDevWatchIgnore — packages/*/dist", () => {
  it("prunes them on win32, where sandbox bind mounts bump their mtimes", () => {
    const ignore = ignoreFor({ platform: "win32" });
    assert.equal(ignore(`${ROOT}/packages/protocol/dist/index.js`), true);
    assert.equal(ignore(`${ROOT}/packages/plugins/chart-plugin/dist/index.js`), true);
  });

  it("keeps package-rebuild HMR on every other platform", () => {
    for (const platform of ["linux", "darwin"] as const) {
      assert.equal(ignoreFor({ platform })(`${ROOT}/packages/protocol/dist/index.js`), false, platform);
    }
  });

  it("honours the win32 opt-back-in escape hatch", () => {
    const ignore = ignoreFor({ platform: "win32", watchPackageDists: true });
    assert.equal(ignore(`${ROOT}/packages/protocol/dist/index.js`), false);
  });

  it("does not prune package sources that merely start with 'dist'", () => {
    const ignore = ignoreFor({ platform: "win32" });
    assert.equal(ignore(`${ROOT}/packages/protocol/src/dist-utils.ts`), false);
    assert.equal(ignore(`${ROOT}/packages/protocol/src/index.ts`), false);
  });

  it("ignores dist directories outside packages/", () => {
    const ignore = ignoreFor({ platform: "win32" });
    assert.equal(ignore(`${ROOT}/dist/server/index.js`), false);
  });
});

describe("createDevWatchIgnore — path normalisation", () => {
  it("accepts Windows separators on both sides", () => {
    const ignore = createDevWatchIgnore({
      projectRoot: "C:\\Users\\dev\\mulmoclaude",
      workspacePath: "C:\\Users\\dev\\mulmoclaude",
      platform: "win32",
    });
    assert.equal(ignore("C:\\Users\\dev\\mulmoclaude\\conversations\\chat\\a.jsonl"), true);
    assert.equal(ignore("C:\\Users\\dev\\mulmoclaude\\packages\\protocol\\dist\\index.js"), true);
    assert.equal(ignore("C:\\Users\\dev\\mulmoclaude\\src\\main.ts"), false);
  });

  it("tolerates a trailing separator on the configured roots", () => {
    const ignore = createDevWatchIgnore({ projectRoot: `${ROOT}/`, workspacePath: `${ROOT}/`, platform: "linux" });
    assert.equal(ignore(`${ROOT}/artifacts/x.md`), true);
  });
});

// The predicate's entry list is a literal, because `WORKSPACE_DIRS` is a
// plugin-aggregated record and pulling it into `vite.config.ts` would drag the
// whole plugin meta graph into config load. These tests are where the two are
// held together instead: a new top-level workspace directory fails here rather
// than silently bringing the reload storms back.
describe("createDevWatchIgnore — stays in sync with the real workspace layout", () => {
  const ignore = ignoreFor({ workspacePath: ROOT });
  const topLevelOf = (workspaceRelative: string): string => {
    const [topLevel] = workspaceRelative.split("/");
    if (topLevel === undefined) throw new Error(`cannot take the top level of ${workspaceRelative}`);
    return topLevel;
  };

  // Top-level entries the watcher deliberately keeps watching: both are tracked
  // repo directories here as well as workspace dirs, so pruning them would stop
  // HMR for real source.
  const DELIBERATELY_WATCHED = new Set(["config", ".claude"]);

  const unprunedTopLevels = (workspaceRelativePaths: string[]): string[] =>
    [...new Set(workspaceRelativePaths.map(topLevelOf))].filter((name) => !DELIBERATELY_WATCHED.has(name) && !ignore(`${ROOT}/${name}`)).sort();

  it("prunes every top-level workspace directory", () => {
    assert.deepEqual(
      unprunedTopLevels(Object.values(WORKSPACE_DIRS)),
      [],
      "new top-level workspace dir — add it to WORKSPACE_RUNTIME_ENTRIES in scripts/lib/devWatchIgnore.ts, or to DELIBERATELY_WATCHED here if it is also tracked repo source",
    );
  });

  it("prunes every workspace file that sits at the workspace root", () => {
    const rootLevelFiles = Object.values(WORKSPACE_FILES).filter((relative) => !relative.includes("/"));
    assert.deepEqual(unprunedTopLevels(rootLevelFiles), []);
  });
});

describe("devWatchIgnoredPrefixes", () => {
  it("reports only the log dir when the workspace lives elsewhere", () => {
    assert.deepEqual(devWatchIgnoredPrefixes({ projectRoot: ROOT, workspacePath: "/elsewhere", platform: "linux" }), [`${ROOT}/server/system/logs`]);
  });

  it("reports the workspace dir when it is nested in the root", () => {
    assert.deepEqual(devWatchIgnoredPrefixes({ projectRoot: ROOT, workspacePath: `${ROOT}/ws`, platform: "linux" }), [
      `${ROOT}/server/system/logs`,
      `${ROOT}/ws`,
    ]);
  });
});
