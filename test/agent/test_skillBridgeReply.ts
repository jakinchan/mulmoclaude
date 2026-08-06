// Regression test for #2821: a bridge must reply with the assistant's answer,
// not the SKILL.md body.
//
// Every bridge (Discord, Telegram, Slack, …) gets its reply from the shared
// relay in `@mulmobridge/chat-service`, which runs inside the MulmoClaude
// server and accumulates `text` session events. The bug was that the server
// published the SKILL.md body as `text` before classifying it, so the relay
// collected 6.6k characters of skill body plus the real answer TWICE (once in
// the raw burst, once from the `skill` flush re-broadcast).
//
// The events here come from the same real captured CLI stream as
// `test_injectedText.ts`, run through the real stream parser, so the input is
// what the CLI actually emits rather than a hand-written approximation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import nodeFs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_TYPES } from "@mulmobridge/protocol";
import { createRelay } from "../../packages/chat-service/src/relay.ts";
import type { RelayDeps } from "../../packages/chat-service/src/relay.ts";
import type { Logger, OnSessionEventFn, Role } from "../../packages/chat-service/src/types.ts";
import type { ChatStateStore, TransportChatState } from "../../packages/chat-service/src/chat-state.ts";
import { createStreamParser, INJECTED_TEXT, type AgentEvent, type RawStreamEvent } from "../../server/agent/stream.js";
import { splitSkillAndReply } from "../../server/agent/skillEvents.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cli-stream-skill.jsonl");
const SKILL_BODY_PREFIX = "Base directory for this skill: ";

const silentLogger: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function parseFixture(): AgentEvent[] {
  const parser = createStreamParser();
  return nodeFs
    .readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => parser.parse(JSON.parse(line) as RawStreamEvent));
}

/** Mirror of `handleAgentEvent`'s publish decision: `claude_session_id` is meta
 *  and injected text is withheld, becoming a `skill` event when a Skill call is
 *  pending. Everything else goes out as-is. */
function publishedByServer(events: AgentEvent[]): Record<string, unknown>[] {
  const published: Record<string, unknown>[] = [];
  let pendingSkillName: string | null = null;
  for (const event of events) {
    if (event.type === EVENT_TYPES.claudeSessionId) continue;
    if (event.type === EVENT_TYPES.toolCall) pendingSkillName = event.toolName === "Skill" ? "bigskill" : null;
    if (event.type !== INJECTED_TEXT) {
      published.push({ ...event });
      continue;
    }
    if (!pendingSkillName) continue;
    const { skillPart, replyPart } = splitSkillAndReply(event.message, null);
    published.push({ source: "assistant", type: EVENT_TYPES.skill, skillName: pendingSkillName, message: skillPart });
    if (replyPart) published.push({ source: "assistant", type: EVENT_TYPES.text, message: replyPart });
    pendingSkillName = null;
  }
  published.push({ type: EVENT_TYPES.sessionFinished });
  return published;
}

function assistantReplyFrom(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: typeof EVENT_TYPES.text }> => event.type === EVENT_TYPES.text)
    .map((event) => event.message)
    .join("");
}

async function relayReply(published: Record<string, unknown>[]): Promise<string> {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const now = new Date(0).toISOString();
  const chatState: TransportChatState = { externalChatId: "chan-1", sessionId: "sess-1", roleId: "general", startedAt: now, updatedAt: now };
  const store: ChatStateStore = {
    getChatState: async () => chatState,
    setChatState: async () => undefined,
    resetChatState: async () => chatState,
    connectSession: async () => chatState,
    generateSessionId: () => chatState.sessionId,
  };
  const onSessionEvent: OnSessionEventFn = (_sessionId, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const emit = (event: Record<string, unknown>) => listeners.forEach((listener) => listener(event));
  const emitAll = () => published.forEach(emit);
  const deps: RelayDeps = {
    store,
    handleCommand: async () => null,
    startChat: async () => {
      setImmediate(emitAll);
      return { kind: "started", chatSessionId: chatState.sessionId };
    },
    onSessionEvent,
    getRole: (roleId: string): Role => ({ id: roleId, name: roleId }),
    defaultRoleId: "general",
    logger: silentLogger,
  };
  const result = await createRelay(deps)({ transportId: "discord", externalChatId: "chan-1", text: "hi" });
  assert.equal(result.kind, "ok");
  return result.kind === "ok" ? result.reply : "";
}

describe("bridge reply after a Skill call (#2821)", () => {
  const events = parseFixture();
  const expectedReply = assistantReplyFrom(events);

  it("fixture sanity: the assistant text is a real answer, not the skill body", () => {
    assert.ok(expectedReply.includes("Tokyo"));
    assert.ok(!expectedReply.includes(SKILL_BODY_PREFIX));
  });

  it("posts the assistant's answer and nothing else", async () => {
    assert.equal(await relayReply(publishedByServer(events)), expectedReply);
  });

  it("never posts the SKILL.md body", async () => {
    const reply = await relayReply(publishedByServer(events));
    assert.ok(!reply.includes(SKILL_BODY_PREFIX), "the body reaching Discord is the reported bug");
    assert.ok(reply.length < 500, `reply should be one short answer, got ${reply.length} chars`);
  });

  it("posts the answer exactly once", async () => {
    const reply = await relayReply(publishedByServer(events));
    const answer = "the capital of Japan is Tokyo";
    assert.equal(reply.split(answer).length - 1, 1, "a second copy means the skill flush re-broadcast a reply that already streamed");
  });

  it("ignores skill events entirely", async () => {
    const withoutSkill = publishedByServer(events).filter((event) => event.type !== EVENT_TYPES.skill);
    assert.equal(await relayReply(withoutSkill), expectedReply, "the reply must not depend on skill events being collected");
  });
});
