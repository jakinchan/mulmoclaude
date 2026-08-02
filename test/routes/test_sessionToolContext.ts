// `/api/mindmap` used to hand every call an empty context, so `add_node` had no
// map to add to: in MulmoClaude a plugin's `execute()` never runs in the client,
// and the create's result lived only in the session (#2754).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { sessionToolContext } from "../../server/api/routes/plugins.ts";
import { __resetForTests, getOrCreateSession, initSessionStore, pushToolResult } from "../../server/events/session-store/index.ts";
import { TOOL_NAMES } from "../../src/config/toolNames.ts";

const NOW = "2026-08-03T00:00:00.000Z";
const session = (sessionId: string) => getOrCreateSession(sessionId, { roleId: "general", resultsFilePath: "/dev/null", startedAt: NOW, updatedAt: NOW });

// The MCP bridge appends `?session=<id>` to every request, which is how the id
// reaches a plugin route at all.
const reqWith = (query: Record<string, unknown>) => ({ query }) as unknown as Request<object, unknown, unknown>;

beforeEach(() => {
  __resetForTests();
  initSessionStore({ publish: () => {} } as unknown as Parameters<typeof initSessionStore>[0]);
});
afterEach(() => __resetForTests());

describe("sessionToolContext (#2754)", () => {
  it("passes the session's latest result for that tool", async () => {
    session("s1");
    await pushToolResult("s1", { toolName: TOOL_NAMES.createMindMap, message: "made a map", data: { nodes: ["root"] } });
    const context = sessionToolContext(reqWith({ session: "s1" }), TOOL_NAMES.createMindMap);
    assert.deepEqual(context.currentResult?.data, { nodes: ["root"] });
  });

  // Every fallback below is a legitimate create, not an error: the empty
  // context is what this route passed before and is still valid.
  it("falls back to an empty context when the session has no result for that tool", async () => {
    session("s1");
    await pushToolResult("s1", { toolName: TOOL_NAMES.putQuestions, message: "q", data: {} });
    assert.equal(sessionToolContext(reqWith({ session: "s1" }), TOOL_NAMES.createMindMap).currentResult, undefined);
  });

  it("falls back when the session is unknown", () => {
    assert.equal(sessionToolContext(reqWith({ session: "nope" }), TOOL_NAMES.createMindMap).currentResult, undefined);
  });

  it("falls back when no session id was sent at all", () => {
    assert.equal(sessionToolContext(reqWith({}), TOOL_NAMES.createMindMap).currentResult, undefined);
  });

  it("does not leak another session's map", async () => {
    session("s1");
    session("s2");
    await pushToolResult("s1", { toolName: TOOL_NAMES.createMindMap, message: "m", data: { which: "s1" } });
    assert.equal(sessionToolContext(reqWith({ session: "s2" }), TOOL_NAMES.createMindMap).currentResult, undefined);
  });
});
