// Tests for the MCP preflight helper (#1352).
//
// Drives the pure functions without spinning up Express. The catalog
// is consumed read-only via `findCatalogEntry`, so the tests work
// against the actual production catalog (matching `notion`,
// `github`, etc. by id) rather than a fixture.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  findMissingRequiredEnv,
  preflightUserServers,
  logPreflightResult,
  _resetPreflightLogCache,
  type McpPreflightResult,
} from "../../server/agent/mcpPreflight.js";
import { findCatalogEntry } from "../../src/config/mcpCatalog.js";
import type { McpServerSpec } from "../../server/system/config.js";
import { log } from "../../server/system/logger/index.js";

beforeEach(() => {
  _resetPreflightLogCache();
});

function getEntry(entryId: string) {
  const entry = findCatalogEntry(entryId);
  if (entry === null) throw new Error(`catalog entry ${entryId} missing — test fixture out of date`);
  return entry;
}

describe("findMissingRequiredEnv — Notion (single required field)", () => {
  it("returns [] when the bound env value is resolved", () => {
    const entry = getEntry("notion");
    const spec: McpServerSpec = {
      type: "stdio",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { NOTION_TOKEN: "secret_xyz" },
    };
    assert.deepEqual(findMissingRequiredEnv(entry, spec), []);
  });

  it("flags the required field when the env value is empty string", () => {
    const entry = getEntry("notion");
    const spec: McpServerSpec = {
      type: "stdio",
      command: "npx",
      env: { NOTION_TOKEN: "" },
    };
    assert.deepEqual(findMissingRequiredEnv(entry, spec), ["NOTION_API_KEY"]);
  });

  it("flags the required field when the env value is whitespace only (Codex review on #1355)", () => {
    // `"   "` has non-zero length but is just as misconfigured as
    // `""` — a server with a whitespace-only token can't
    // authenticate. Without trimming, preflight greenlit it.
    const entry = getEntry("notion");
    const spec: McpServerSpec = {
      type: "stdio",
      command: "npx",
      env: { NOTION_TOKEN: "   " },
    };
    assert.deepEqual(findMissingRequiredEnv(entry, spec), ["NOTION_API_KEY"]);
  });

  it("flags the required field when the env key is missing entirely", () => {
    const entry = getEntry("notion");
    const spec: McpServerSpec = {
      type: "stdio",
      command: "npx",
      env: {},
    };
    assert.deepEqual(findMissingRequiredEnv(entry, spec), ["NOTION_API_KEY"]);
  });

  it("flags the required field when the env value still holds the unresolved ${KEY} placeholder", () => {
    // Settings UI is supposed to substitute placeholders before
    // writing mcp.json, but a hand-edited file might leave them
    // unresolved. Treat as missing so the operator gets the warn.
    const entry = getEntry("notion");
    const spec: McpServerSpec = {
      type: "stdio",
      command: "npx",
      env: { NOTION_TOKEN: "${NOTION_API_KEY}" },
    };
    assert.deepEqual(findMissingRequiredEnv(entry, spec), ["NOTION_API_KEY"]);
  });
});

describe("findMissingRequiredEnv — Slack (two required fields)", () => {
  it("reports only the missing one when others are set", () => {
    const entry = getEntry("slack");
    const spec: McpServerSpec = {
      type: "stdio",
      command: "npx",
      env: { SLACK_BOT_TOKEN: "xoxb-real", SLACK_TEAM_ID: "" },
    };
    assert.deepEqual(findMissingRequiredEnv(entry, spec), ["SLACK_TEAM_ID"]);
  });

  it("reports both when both are missing", () => {
    const entry = getEntry("slack");
    const spec: McpServerSpec = { type: "stdio", command: "npx", env: {} };
    const missing = findMissingRequiredEnv(entry, spec);
    assert.deepEqual(missing.sort(), ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"]);
  });
});

describe("findMissingRequiredEnv — HTTP entries fall through (no env to check)", () => {
  it("returns [] for the HTTP-typed deepwiki entry", () => {
    const entry = getEntry("deepwiki");
    const spec: McpServerSpec = { type: "http", url: "https://mcp.deepwiki.com/sse" };
    assert.deepEqual(findMissingRequiredEnv(entry, spec), []);
  });
});

describe("preflightUserServers", () => {
  it("passes through a custom server with no catalog match", () => {
    const userServers: Record<string, McpServerSpec> = {
      "my-custom-server": { type: "stdio", command: "node", args: ["./bin.js"] },
    };
    const result = preflightUserServers(userServers);
    assert.deepEqual(Object.keys(result.ready), ["my-custom-server"]);
    assert.deepEqual(result.skipped, []);
  });

  it("excludes a catalog server with missing required config", () => {
    const userServers: Record<string, McpServerSpec> = {
      notion: { type: "stdio", command: "npx", env: { NOTION_TOKEN: "" } },
    };
    const result = preflightUserServers(userServers);
    assert.deepEqual(Object.keys(result.ready), []);
    assert.deepEqual(result.skipped, [{ serverId: "notion", missing: ["NOTION_API_KEY"] }]);
  });

  it("passes catalog servers with all required env populated", () => {
    const userServers: Record<string, McpServerSpec> = {
      notion: { type: "stdio", command: "npx", env: { NOTION_TOKEN: "secret_xyz" } },
    };
    const result = preflightUserServers(userServers);
    assert.deepEqual(Object.keys(result.ready), ["notion"]);
    assert.deepEqual(result.skipped, []);
  });

  it("handles a mix: one ready, one skipped, one custom — all in one pass", () => {
    const userServers: Record<string, McpServerSpec> = {
      notion: { type: "stdio", command: "npx", env: { NOTION_TOKEN: "secret_ok" } },
      slack: { type: "stdio", command: "npx", env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" } },
      "my-custom": { type: "stdio", command: "node" },
    };
    const result = preflightUserServers(userServers);
    assert.deepEqual(Object.keys(result.ready).sort(), ["my-custom", "notion"]);
    assert.equal(result.skipped.length, 1);
    const [skipped] = result.skipped;
    assert.ok(skipped);
    assert.equal(skipped.serverId, "slack");
    assert.deepEqual(skipped.missing.sort(), ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"]);
  });
});

describe("logPreflightResult — snapshot diffing (Codex review on #1355)", () => {
  // Capture log.warn calls so we can assert on the dedup behavior
  // without spinning up the real transport.
  function captureWarn(): { calls: { serverId: string; missing: string[] }[]; restore: () => void } {
    const originalWarn = log.warn;
    const calls: { serverId: string; missing: string[] }[] = [];
    log.warn = (_namespace, _message, data) => {
      if (data && typeof data === "object" && "serverId" in data && "missing" in data) {
        const { serverId, missing } = data as { serverId: unknown; missing: unknown };
        if (typeof serverId === "string" && Array.isArray(missing)) {
          calls.push({ serverId, missing: missing as string[] });
        }
      }
    };
    return {
      calls,
      restore: () => {
        log.warn = originalWarn;
      },
    };
  }

  function emptyResult(): McpPreflightResult {
    return { ready: {}, skipped: [] };
  }

  function skipResult(serverId: string, missing: string[]): McpPreflightResult {
    return { ready: {}, skipped: [{ serverId, missing }] };
  }

  it("logs identical state only once across consecutive agent-run calls", () => {
    const { calls, restore } = captureWarn();
    try {
      const notionSkipped = skipResult("notion", ["NOTION_API_KEY"]);
      logPreflightResult(notionSkipped, "agent-run");
      logPreflightResult(notionSkipped, "agent-run");
      logPreflightResult(notionSkipped, "agent-run");
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.ok(call);
      assert.equal(call.serverId, "notion");
    } finally {
      restore();
    }
  });

  it("re-logs after a server goes missing → fixed → missing again", () => {
    // Regression guard for the monotonic-Set bug Codex flagged: the
    // earlier shape only ever added to the dedup set, so a fix-then-
    // re-break sequence silently suppressed the second warning.
    const { calls, restore } = captureWarn();
    try {
      logPreflightResult(skipResult("notion", ["NOTION_API_KEY"]), "agent-run"); // log #1
      logPreflightResult(emptyResult(), "agent-run"); // user fixed it — nothing to log
      logPreflightResult(skipResult("notion", ["NOTION_API_KEY"]), "agent-run"); // re-broken — must log #2
      assert.equal(calls.length, 2);
      assert.deepEqual(
        calls.map((call) => call.serverId),
        ["notion", "notion"],
      );
    } finally {
      restore();
    }
  });

  it("logs again when the missing-key set changes for the same server", () => {
    const { calls, restore } = captureWarn();
    try {
      logPreflightResult(skipResult("slack", ["SLACK_BOT_TOKEN"]), "agent-run");
      logPreflightResult(skipResult("slack", ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"]), "agent-run");
      assert.equal(calls.length, 2);
      const [, secondCall] = calls;
      assert.ok(secondCall);
      assert.deepEqual(secondCall.missing, ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"]);
    } finally {
      restore();
    }
  });

  it("boot mode always logs even when state hasn't changed since the last agent run", () => {
    const { calls, restore } = captureWarn();
    try {
      logPreflightResult(skipResult("notion", ["NOTION_API_KEY"]), "agent-run");
      logPreflightResult(skipResult("notion", ["NOTION_API_KEY"]), "boot");
      assert.equal(calls.length, 2);
    } finally {
      restore();
    }
  });
});
