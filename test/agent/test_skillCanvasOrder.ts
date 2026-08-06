// The canvas must show: assistant prose → collapsed skill card → the reply.
//
// This is the ordering hazard #2821's fix introduces. The skill card used to
// OVERWRITE the trailing assistant card, which was safe only because the card
// underneath was the streamed SKILL.md body. Now that the server withholds the
// body, the trailing card is the model's own "I'll use the X skill" prose — so
// the same overwrite would delete real output, and a card appended too late
// would sit after the reply instead of before it.
//
// Drives the real `applyAgentEvent` dispatcher with the sequence the server
// publishes (measured in `test_injectedText.ts`): prose deltas, the Skill tool
// call and its result, the `skill` event, then the reply deltas.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyAgentEvent, type AgentEventContext } from "../../src/utils/agent/eventDispatch";
import { EVENT_TYPES } from "../../src/types/events";
import type { ActiveSession } from "../../src/types/session";
import type { SseEvent } from "../../src/types/sse";

const PROSE = "I'll use the nazonazo skill.";
const REPLY_CHUNKS = ["なぞなぞ、", "始めましょう！"];
const SKILL_BODY = "Base directory for this skill: /ws/.claude/skills/nazonazo\n\n# nazonazo\n\n...";

function makeSession(): ActiveSession {
  return {
    id: "sess-1",
    roleId: "general",
    toolResults: [],
    resultTimestamps: new Map(),
    isRunning: false,
    statusMessage: "",
    toolCallHistory: [],
    selectedResultUuid: null,
    hasUnread: false,
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    runStartIndex: 0,
    assistantTextInterrupted: false,
    pendingGenerations: {},
  };
}

const publishedSequence: SseEvent[] = [
  { type: EVENT_TYPES.text, message: PROSE, source: "assistant" },
  { type: EVENT_TYPES.toolCall, toolUseId: "tu_1", toolName: "Skill", args: { skill: "nazonazo" } },
  { type: EVENT_TYPES.toolCallResult, toolUseId: "tu_1", content: "Launching skill: nazonazo" },
  {
    type: EVENT_TYPES.skill,
    source: "assistant",
    skillName: "nazonazo",
    skillScope: "project",
    skillPath: "/ws/.claude/skills/nazonazo/SKILL.md",
    skillDescription: "Riddles",
    message: SKILL_BODY,
  },
  ...REPLY_CHUNKS.map((message): SseEvent => ({ type: EVENT_TYPES.text, message, source: "assistant" })),
] as SseEvent[];

async function replay(): Promise<ActiveSession> {
  const session = makeSession();
  const ctx: AgentEventContext = {
    session,
    refreshRoles: async () => undefined,
    scrollSidebarToBottom: () => undefined,
    onGenerationsDrained: () => undefined,
  };
  for (const event of publishedSequence) {
    await applyAgentEvent(event, ctx);
  }
  return session;
}

describe("canvas layout for a Skill turn (#2821)", () => {
  it("keeps prose, skill card and reply as three cards in that order", async () => {
    const { toolResults } = await replay();
    assert.deepEqual(
      toolResults.map((result) => result.toolName),
      ["text-response", "skill", "text-response"],
    );
  });

  it("does not overwrite the assistant's prose with the skill card", async () => {
    const [prose] = (await replay()).toolResults;
    assert.ok(prose);
    assert.equal((prose.data as { text?: string }).text, PROSE);
  });

  it("streams the reply into one card after the skill", async () => {
    const { toolResults } = await replay();
    const reply = toolResults[2];
    assert.ok(reply);
    assert.equal((reply.data as { text?: string }).text, REPLY_CHUNKS.join(""), "deltas must merge, not open a card each");
  });

  it("never renders the SKILL.md body as chat prose", async () => {
    const proseCards = (await replay()).toolResults.filter((result) => result.toolName === "text-response");
    const rendered = proseCards.map((result) => (result.data as { text?: string }).text ?? "").join("");
    assert.ok(!rendered.includes("Base directory for this skill:"), "the body belongs to the collapsed skill card only");
  });
});
