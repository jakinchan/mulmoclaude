// Unit tests for the config-refresh handler.
//
// Coverage:
//   - Fires on canonical .claude/skills/<slug>/SKILL.md writes
//   - Fires on config/scheduler/tasks.json writes
//   - Does NOT fire on the skill-bridge staging path
//     (data/skills/<slug>/SKILL.md) — that's owned by skillBridge,
//     which fires refresh itself AFTER the mirror to avoid a race.
//   - Ignores non-matching paths

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleConfigRefresh } from "../../../../server/workspace/hooks/handlers/configRefresh.js";

let workspace: string;
let captured: string[];
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "config-refresh-"));
  process.env.CLAUDE_PROJECT_DIR = workspace;
  // Sidecars so buildAuthPost returns a real request — otherwise
  // safePost short-circuits and we can't observe whether refresh
  // would have fired.
  await writeFile(path.join(workspace, ".session-token"), "test-token", "utf-8");
  await writeFile(path.join(workspace, ".server-port"), "65535", "utf-8");
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    captured.push(url);
    return new Response(null, { status: 204 });
  };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(workspace, { recursive: true, force: true });
});

describe("handleConfigRefresh", () => {
  it("fires refresh on .claude/skills/<slug>/SKILL.md", async () => {
    await mkdir(path.join(workspace, ".claude", "skills", "foo"), { recursive: true });
    await handleConfigRefresh({
      tool_name: "Write",
      tool_input: { file_path: path.join(workspace, ".claude", "skills", "foo", "SKILL.md") },
    });
    assert.equal(captured.length, 1);
    const [refreshUrl] = captured;
    assert.ok(refreshUrl);
    assert.ok(refreshUrl.endsWith("/api/config/refresh"));
  });

  it("fires refresh on config/scheduler/tasks.json", async () => {
    await handleConfigRefresh({
      tool_name: "Edit",
      tool_input: { file_path: path.join(workspace, "config", "scheduler", "tasks.json") },
    });
    assert.equal(captured.length, 1);
    const [refreshUrl] = captured;
    assert.ok(refreshUrl);
    assert.ok(refreshUrl.endsWith("/api/config/refresh"));
  });

  it("does NOT fire on data/skills/<slug>/SKILL.md (skillBridge owns that)", async () => {
    // Codex regression: previously this handler matched the
    // staging path too, racing with skillBridge's mirror copy.
    // skillBridge now owns the refresh trigger for staging writes,
    // so this handler must stay silent on them.
    await handleConfigRefresh({
      tool_name: "Write",
      tool_input: { file_path: path.join(workspace, "data", "skills", "nazonazo", "SKILL.md") },
    });
    assert.equal(captured.length, 0);
  });

  it("ignores unrelated writes", async () => {
    await handleConfigRefresh({
      tool_name: "Write",
      tool_input: { file_path: path.join(workspace, "data", "wiki", "page.md") },
    });
    assert.equal(captured.length, 0);
  });

  it("ignores non-Write tools", async () => {
    await handleConfigRefresh({
      tool_name: "Bash",
      tool_input: { command: "cat .claude/skills/foo/SKILL.md" },
    });
    assert.equal(captured.length, 0);
  });
});
