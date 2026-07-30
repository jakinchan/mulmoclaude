import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { claudeConfigDir, claudeConfigJson, claudeCredentialsPath, claudeSkillsDir } from "../../server/utils/claudeConfigPath.js";

// Each helper accepts an explicit `override` whose default is the
// frozen `env.claudeConfigDir` / `env.claudeConfigJson` snapshot
// (captured at module load from `process.env.CLAUDE_*`). Passing the
// override directly here exercises the env-set branch without
// requiring a subprocess. The propagation into the Docker bind
// mounts in `buildDockerSpawnArgs` is the existing
// `test_agent_config.ts` "mounts the .claude credentials from the
// home dir" test (line ~378) — that asserts the helper's return
// value lands verbatim in the `-v` arg, which holds regardless of
// whether the value came from env or the homedir fallback.
//
// The env vars reaching those defaults at all is `test_claudeConfigEnv.ts`,
// which needs child processes for it.

const FAKE_HOME = "/fake/home/user";
const ENV_DIR = "/sandboxed/claude-config";
const ENV_JSON = "/sandboxed/claude.json";
// Every case passes both overrides explicitly, so a developer running the
// suite with a relocated Claude install can't turn a default-behaviour
// assertion red.
const NO_OVERRIDE = undefined;
const BLANK_OVERRIDES = ["", "   "];

describe("claudeConfigDir", () => {
  it("defaults to <home>/.claude when override is undefined", () => {
    assert.equal(claudeConfigDir(FAKE_HOME, NO_OVERRIDE), join(FAKE_HOME, ".claude"));
  });

  it("returns the override verbatim when set", () => {
    assert.equal(claudeConfigDir(FAKE_HOME, ENV_DIR), ENV_DIR);
  });

  it("override wins over home param", () => {
    assert.equal(claudeConfigDir("/some/other/home", ENV_DIR), ENV_DIR);
  });

  BLANK_OVERRIDES.forEach((blank) => {
    it(`falls back to <home>/.claude for a blank override (${JSON.stringify(blank)})`, () => {
      assert.equal(claudeConfigDir(FAKE_HOME, blank), join(FAKE_HOME, ".claude"));
    });
  });
});

describe("claudeConfigJson", () => {
  it("defaults to <home>/.claude.json when neither override is set", () => {
    assert.equal(claudeConfigJson(FAKE_HOME, NO_OVERRIDE, NO_OVERRIDE), join(FAKE_HOME, ".claude.json"));
  });

  it("returns the override verbatim when set", () => {
    assert.equal(claudeConfigJson(FAKE_HOME, ENV_JSON, NO_OVERRIDE), ENV_JSON);
  });

  // The bug: Claude Code keeps `.claude.json` inside `CLAUDE_CONFIG_DIR`, so a
  // user who set only that var was handed `<home>/.claude.json` — a path with
  // nothing at it (#2654).
  it("resolves inside the dir override when only CLAUDE_CONFIG_DIR is set", () => {
    assert.equal(claudeConfigJson(FAKE_HOME, NO_OVERRIDE, ENV_DIR), join(ENV_DIR, ".claude.json"));
  });

  it("lets an explicit json override win over the dir override", () => {
    assert.equal(claudeConfigJson(FAKE_HOME, ENV_JSON, ENV_DIR), ENV_JSON);
  });

  // The two helpers feed two `-v` args of one `docker run`, so disagreeing
  // about which directory holds the config is the whole failure mode.
  it("agrees with claudeConfigDir about where the config lives", () => {
    assert.equal(claudeConfigJson(FAKE_HOME, NO_OVERRIDE, ENV_DIR), join(claudeConfigDir(FAKE_HOME, ENV_DIR), ".claude.json"));
  });

  BLANK_OVERRIDES.forEach((blank) => {
    it(`ignores a blank dir override (${JSON.stringify(blank)}) instead of returning a relative path`, () => {
      assert.equal(claudeConfigJson(FAKE_HOME, NO_OVERRIDE, blank), join(FAKE_HOME, ".claude.json"));
    });

    it(`ignores a blank json override (${JSON.stringify(blank)})`, () => {
      assert.equal(claudeConfigJson(FAKE_HOME, blank, NO_OVERRIDE), join(FAKE_HOME, ".claude.json"));
    });
  });
});

describe("claudeCredentialsPath", () => {
  it("derives <claudeConfigDir>/.credentials.json from the default dir", () => {
    assert.equal(claudeCredentialsPath(FAKE_HOME), join(FAKE_HOME, ".claude", ".credentials.json"));
  });

  it("derives <override>/.credentials.json when an override dir is provided", () => {
    assert.equal(claudeCredentialsPath(FAKE_HOME, ENV_DIR), join(ENV_DIR, ".credentials.json"));
  });

  it("falls back to the home dir for a blank override dir", () => {
    assert.equal(claudeCredentialsPath(FAKE_HOME, ""), join(FAKE_HOME, ".claude", ".credentials.json"));
  });
});

describe("claudeSkillsDir", () => {
  it("derives <claudeConfigDir>/skills from the default dir", () => {
    assert.equal(claudeSkillsDir(FAKE_HOME), join(FAKE_HOME, ".claude", "skills"));
  });

  it("derives <override>/skills when an override dir is provided", () => {
    assert.equal(claudeSkillsDir(FAKE_HOME, ENV_DIR), join(ENV_DIR, "skills"));
  });

  it("falls back to the home dir for a blank override dir", () => {
    assert.equal(claudeSkillsDir(FAKE_HOME, ""), join(FAKE_HOME, ".claude", "skills"));
  });
});
