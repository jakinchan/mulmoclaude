// Unit tests for the `spawnBackgroundChat` MCP tool. Deps (startChat,
// readSessionOrigin) are injected so we exercise the origin mapping,
// the no-nesting refusal, and the runaway cap WITHOUT launching real
// `claude` subprocesses.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  makeSpawnBackgroundChatTool,
  spawnBackgroundChat,
  type StartChatFn,
  type ReadSessionOriginFn,
} from "../../server/agent/mcp-tools/spawnBackgroundChat.ts";
import { mcpTools } from "../../server/agent/mcp-tools/index.ts";
import { reserveBackgroundSession, releaseBackgroundSession, MAX_BACKGROUND_SESSIONS } from "../../server/agent/backgroundSessions.ts";
import { SESSION_ORIGINS } from "../../src/types/session.ts";

type StartChatCall = Parameters<StartChatFn>[0];

function makeMockStartChat(result: Awaited<ReturnType<StartChatFn>> = { kind: "started", chatSessionId: "ignored" }): {
  startChat: StartChatFn;
  calls: StartChatCall[];
} {
  const calls: StartChatCall[] = [];
  const startChat: StartChatFn = async (params) => {
    calls.push(params);
    return result;
  };
  return { startChat, calls };
}

const originNone: ReadSessionOriginFn = async () => undefined;

// Parse the `{ chatId }` JSON a successful spawn returns, and release
// the runaway-guard slot it reserved so tests don't leak into each
// other's in-flight count.
function chatIdFrom(result: string): string {
  const parsed = JSON.parse(result) as { chatId?: string };
  assert.ok(parsed.chatId, `expected a chatId in result: ${result}`);
  return parsed.chatId;
}

describe("spawnBackgroundChat — input validation", () => {
  it("rejects a missing / empty message", async () => {
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: originNone });
    assert.match(await tool.handler({ role: "tutor", hidden: true }), /message.*required/i);
    assert.match(await tool.handler({ message: "   ", role: "tutor", hidden: true }), /message.*required/i);
    assert.equal(calls.length, 0);
  });

  it("rejects a missing / empty role", async () => {
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: originNone });
    assert.match(await tool.handler({ message: "do x", hidden: true }), /role.*required/i);
    assert.equal(calls.length, 0);
  });

  it("rejects a non-boolean hidden", async () => {
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: originNone });
    assert.match(await tool.handler({ message: "do x", role: "tutor" }), /hidden.*required/i);
    assert.match(await tool.handler({ message: "do x", role: "tutor", hidden: "yes" }), /hidden.*required/i);
    assert.equal(calls.length, 0);
  });
});

describe("spawnBackgroundChat — origin mapping", () => {
  it("hidden:true → origin `system`, and returns the chatId", async () => {
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: originNone });
    let chatId: string | undefined;
    try {
      const result = await tool.handler({ message: "author lesson 2", role: "tutor", hidden: true });
      chatId = chatIdFrom(result);
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.ok(call);
      assert.equal(call.origin, SESSION_ORIGINS.system);
      assert.equal(call.roleId, "tutor");
      assert.equal(call.chatSessionId, chatId);
      assert.equal(call.message, "author lesson 2");
    } finally {
      if (chatId) releaseBackgroundSession(chatId);
    }
  });

  it("hidden:false → origin `skill` (visible)", async () => {
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: originNone });
    const result = await tool.handler({ message: "open a chat", role: "general", hidden: false });
    chatIdFrom(result);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.origin, SESSION_ORIGINS.skill);
  });

  it("trims message and role before passing them to startChat", async () => {
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: originNone });
    let chatId: string | undefined;
    try {
      const result = await tool.handler({ message: "  go  ", role: "  tutor  ", hidden: true });
      chatId = chatIdFrom(result);
      const [call] = calls;
      assert.ok(call);
      assert.equal(call.message, "go");
      assert.equal(call.roleId, "tutor");
    } finally {
      if (chatId) releaseBackgroundSession(chatId);
    }
  });
});

describe("spawnBackgroundChat — no nesting", () => {
  it("refuses when the calling session is itself a hidden worker (origin `system`)", async () => {
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: async () => SESSION_ORIGINS.system });
    const result = await tool.handler({ message: "spawn more", role: "tutor", hidden: true }, { sessionId: "worker-1" });
    assert.match(result, /cannot spawn further background sessions/i);
    assert.equal(calls.length, 0);
  });

  it("allows spawning when the calling session is a normal conversation", async () => {
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: async () => SESSION_ORIGINS.human });
    let chatId: string | undefined;
    try {
      const result = await tool.handler({ message: "go", role: "tutor", hidden: true }, { sessionId: "human-1" });
      chatId = chatIdFrom(result);
      assert.equal(calls.length, 1);
    } finally {
      if (chatId) releaseBackgroundSession(chatId);
    }
  });
});

describe("spawnBackgroundChat — runaway guard", () => {
  it("refuses a hidden spawn once the concurrency cap is reached", async () => {
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: originNone });
    const fillIds = Array.from({ length: MAX_BACKGROUND_SESSIONS }, (_unused, i) => `cap-fill-${i}`);
    fillIds.forEach(reserveBackgroundSession);
    try {
      const result = await tool.handler({ message: "go", role: "tutor", hidden: true });
      assert.match(result, /too many background sessions/i);
      assert.equal(calls.length, 0, "must not call startChat when over the cap");
    } finally {
      fillIds.forEach(releaseBackgroundSession);
    }
  });

  it("reserves atomically before launch — concurrent calls cannot exceed the cap", async () => {
    // Leave exactly one free slot, then fire two hidden spawns concurrently.
    // With `ctx` omitted there is no `await` before the reserve, so the first
    // handler() synchronously claims the last slot before yielding at
    // `await startChat`; the second must be refused. A check-then-reserve split
    // around the await (the previous bug) would let BOTH launch.
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: originNone });
    const fillIds = Array.from({ length: MAX_BACKGROUND_SESSIONS - 1 }, (_unused, i) => `race-fill-${i}`);
    fillIds.forEach(reserveBackgroundSession);
    const launched: string[] = [];
    try {
      const results = await Promise.all([
        tool.handler({ message: "a", role: "tutor", hidden: true }),
        tool.handler({ message: "b", role: "tutor", hidden: true }),
      ]);
      const isRefusal = (res: string): boolean => /too many background sessions/i.test(res);
      const refused = results.filter(isRefusal);
      assert.equal(refused.length, 1, "exactly one call must be refused");
      assert.equal(results.length - refused.length, 1, "exactly one call must launch");
      assert.equal(calls.length, 1, "startChat called only for the one that reserved a slot");
      results.filter((res) => !isRefusal(res)).forEach((res) => launched.push(chatIdFrom(res)));
    } finally {
      fillIds.forEach(releaseBackgroundSession);
      launched.forEach(releaseBackgroundSession);
    }
  });

  it("does NOT apply the cap to visible (hidden:false) spawns", async () => {
    const { startChat, calls } = makeMockStartChat();
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: originNone });
    const fillIds = Array.from({ length: MAX_BACKGROUND_SESSIONS }, (_unused, i) => `cap-fill2-${i}`);
    fillIds.forEach(reserveBackgroundSession);
    try {
      const result = await tool.handler({ message: "go", role: "general", hidden: false });
      chatIdFrom(result);
      assert.equal(calls.length, 1, "visible spawns are not capped");
    } finally {
      fillIds.forEach(releaseBackgroundSession);
    }
  });
});

describe("spawnBackgroundChat — startChat failure", () => {
  it("surfaces a startChat error and rolls back the reserved slot", async () => {
    const { startChat, calls } = makeMockStartChat({ kind: "error", error: "boom" });
    const tool = makeSpawnBackgroundChatTool({ startChat, readSessionOrigin: originNone });
    // Fill to one below the cap so a leaked reservation would tip it over.
    const fillIds = Array.from({ length: MAX_BACKGROUND_SESSIONS - 1 }, (_unused, i) => `fail-fill-${i}`);
    fillIds.forEach(reserveBackgroundSession);
    try {
      const result = await tool.handler({ message: "go", role: "tutor", hidden: true });
      assert.match(result, /failed to start chat: boom/i);
      assert.equal(calls.length, 1);
      // A failed launch must leave room — the next hidden spawn still succeeds.
      const { startChat: ok, calls: okCalls } = makeMockStartChat();
      const okTool = makeSpawnBackgroundChatTool({ startChat: ok, readSessionOrigin: originNone });
      const okResult = await okTool.handler({ message: "go2", role: "tutor", hidden: true });
      assert.equal(okCalls.length, 1, "a failed launch must not have consumed the last slot");
      releaseBackgroundSession(chatIdFrom(okResult));
    } finally {
      fillIds.forEach(releaseBackgroundSession);
    }
  });
});

describe("spawnBackgroundChat — registry integration", () => {
  it("is registered in the production mcpTools array", () => {
    assert.ok(mcpTools.includes(spawnBackgroundChat), "spawnBackgroundChat must be in the mcpTools registry");
  });

  it("is flagged alwaysActive so every role gets it", () => {
    assert.equal(spawnBackgroundChat.alwaysActive, true);
  });

  it("declares message, role, and hidden as required", () => {
    const schema = spawnBackgroundChat.definition.inputSchema as { required: readonly string[] };
    assert.deepEqual([...schema.required].sort(), ["hidden", "message", "role"]);
  });
});
