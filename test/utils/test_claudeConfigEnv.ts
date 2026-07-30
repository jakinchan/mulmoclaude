// End-to-end wiring for the two Claude-config env vars, spawned as child
// processes because `server/system/env.ts` snapshots `process.env` once at
// module load — assigning `process.env.CLAUDE_CONFIG_DIR` in this process is a
// no-op, so the env-set branch is only reachable from a fresh interpreter.
//
// `test_claudeConfigPath.ts` covers the helpers by passing overrides directly.
// That cannot see the bug #2654 was about: `claudeConfigDir()` honoured
// `CLAUDE_CONFIG_DIR` while `claudeConfigJson()` ignored it, so the two Docker
// `-v` args ended up in DIFFERENT directories. The invariant lives across two
// call sites and a frozen env snapshot, which is what this file pins.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);
const repoRoot = resolve(__dirname, "..", "..");
// Absolute URLs so the child resolves them regardless of its cwd, and tsx's
// loader entry via `--import` so it can consume the `.ts` sources directly —
// same approach as `test/plugins/test_preset_loader_node_path.ts`.
const CONFIG_PATH_URL = pathToFileURL(resolve(repoRoot, "server", "utils", "claudeConfigPath.ts")).href;
const AGENT_CONFIG_URL = pathToFileURL(resolve(repoRoot, "server", "agent", "config.ts")).href;
const TSX_LOADER_URL = pathToFileURL(localRequire.resolve("tsx")).href;

const HOME = "/home/u";
const CONFIG_DIR = "/relocated/claude-config";
const EXPLICIT_JSON = "/elsewhere/claude.json";

interface ResolvedPaths {
  dir: string;
  json: string;
  dirMount: string | undefined;
  jsonMount: string | undefined;
}

// `dockerBindMountArgs` is included on purpose: it is the call site that turns
// the two helpers into mounts, and it passes only `homeDir` — so a future edit
// that hands one helper an override and not the other shows up here.
function resolveInChild(claudeEnv: Record<string, string>): ResolvedPaths {
  const script = `
    const { claudeConfigDir, claudeConfigJson } = await import(${JSON.stringify(CONFIG_PATH_URL)});
    const { dockerBindMountArgs } = await import(${JSON.stringify(AGENT_CONFIG_URL)});
    const mounts = dockerBindMountArgs({
      projectRoot: "/proj",
      packageRoot: "/pkg",
      workspacePath: "/ws",
      homeDir: ${JSON.stringify(HOME)},
      packagesMount: [],
      platform: "linux",
    });
    process.stdout.write(JSON.stringify({
      dir: claudeConfigDir(${JSON.stringify(HOME)}),
      json: claudeConfigJson(${JSON.stringify(HOME)}),
      dirMount: mounts.find((arg) => arg.endsWith(":/home/node/.claude")),
      jsonMount: mounts.find((arg) => arg.endsWith(":/home/node/.claude.json")),
    }));
  `;
  // Both vars are removed before the case's own values go in, so a developer who
  // has genuinely relocated their Claude install cannot leak into the
  // "neither is set" case.
  const childEnv = { ...process.env };
  delete childEnv.CLAUDE_CONFIG_DIR;
  delete childEnv.CLAUDE_CONFIG_JSON;
  const stdout = execFileSync(process.execPath, ["--import", TSX_LOADER_URL, "--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: { ...childEnv, ...claudeEnv },
    encoding: "utf-8",
  });
  return JSON.parse(stdout);
}

describe("CLAUDE_CONFIG_DIR / CLAUDE_CONFIG_JSON wiring (#2654)", () => {
  it("keeps both paths under the home dir when neither var is set", () => {
    const paths = resolveInChild({});
    assert.equal(paths.dir, `${HOME}/.claude`);
    assert.equal(paths.json, `${HOME}/.claude.json`);
    assert.equal(paths.dirMount, `${HOME}/.claude:/home/node/.claude`);
    assert.equal(paths.jsonMount, `${HOME}/.claude.json:/home/node/.claude.json`);
  });

  it("moves .claude.json into CLAUDE_CONFIG_DIR, so both mounts stay in one directory", () => {
    const paths = resolveInChild({ CLAUDE_CONFIG_DIR: CONFIG_DIR });
    assert.equal(paths.dir, CONFIG_DIR);
    assert.equal(paths.json, `${CONFIG_DIR}/.claude.json`);
    assert.equal(paths.dirMount, `${CONFIG_DIR}:/home/node/.claude`);
    assert.equal(paths.jsonMount, `${CONFIG_DIR}/.claude.json:/home/node/.claude.json`);
  });

  it("lets an explicit CLAUDE_CONFIG_JSON win over CLAUDE_CONFIG_DIR", () => {
    const paths = resolveInChild({ CLAUDE_CONFIG_DIR: CONFIG_DIR, CLAUDE_CONFIG_JSON: EXPLICIT_JSON });
    assert.equal(paths.dir, CONFIG_DIR);
    assert.equal(paths.json, EXPLICIT_JSON);
    assert.equal(paths.jsonMount, `${EXPLICIT_JSON}:/home/node/.claude.json`);
  });

  it("treats a blank CLAUDE_CONFIG_DIR as unset rather than mounting a cwd-relative path", () => {
    const paths = resolveInChild({ CLAUDE_CONFIG_DIR: "   " });
    assert.equal(paths.dir, `${HOME}/.claude`);
    assert.equal(paths.json, `${HOME}/.claude.json`);
    assert.equal(paths.jsonMount, `${HOME}/.claude.json:/home/node/.claude.json`);
  });
});
