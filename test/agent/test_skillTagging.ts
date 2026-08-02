// Verifies the live SSE dispatch path for skill entries (#1218) —
// `applySkillEvent` replaces the in-flight streamed assistant text
// bubble with a collapsed skill envelope, preserving the uuid so any
// view bound to it doesn't blink off.
//
// The server-side state machine (`pendingSkill` flag in
// `EventContext`, sequence-based detection on `toolName === "Skill"`,
// metadata enrichment via `discoverSkills()`) is harder to unit-test
// without spinning up the full agent route — that path is covered by
// the existing route-level tests; here we pin the client mutation
// contract that the server's broadcast feeds into.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { applySkillEvent } from "../../src/utils/session/sessionHelpers";
import { makeTextResult } from "../../src/utils/tools/result";
import type { ActiveSession } from "../../src/types/session";

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
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runStartIndex: 0,
    assistantTextInterrupted: false,
    pendingGenerations: {},
  };
}

const skillPayload = {
  skillName: "mc-library",
  skillScope: "project" as const,
  skillPath: "/abs/path/SKILL.md",
  skillDescription: "Personal book journal",
  message: "Base directory for this skill: /abs/path\n\n# Personal book journal\n\n...",
};

describe("applySkillEvent (#1218) — replace streamed assistant text in place", () => {
  let session: ActiveSession;

  beforeEach(() => {
    session = makeSession();
  });

  it("replaces a trailing assistant text-response with a skill envelope, preserving uuid", () => {
    const streamed = makeTextResult("Base directory for this skill: ...", "assistant");
    session.toolResults.push(streamed);
    const originalUuid = streamed.uuid;

    applySkillEvent(session, skillPayload);

    assert.equal(session.toolResults.length, 1, "no new card pushed when one was replaced in place");
    const [card] = session.toolResults;
    assert.ok(card);
    assert.equal(card.toolName, "skill");
    assert.equal(card.uuid, originalUuid, "uuid preserved so view bindings stay attached");
  });

  it("pushes a new skill card when no streamed assistant text precedes it", () => {
    applySkillEvent(session, skillPayload);
    assert.equal(session.toolResults.length, 1);
    const [card] = session.toolResults;
    assert.ok(card);
    assert.equal(card.toolName, "skill");
  });

  it("does NOT replace a trailing user text-response (would corrupt the user's message)", () => {
    const userMsg = makeTextResult("hello", "user");
    session.toolResults.push(userMsg);
    applySkillEvent(session, skillPayload);
    assert.equal(session.toolResults.length, 2, "user text stays, skill is appended");
    const [userCard, skillCard] = session.toolResults;
    assert.ok(userCard);
    assert.ok(skillCard);
    assert.equal(userCard.toolName, "text-response");
    assert.equal(skillCard.toolName, "skill");
  });

  it("does NOT replace a non-text-response trailing card (e.g. image / wiki result)", () => {
    session.toolResults.push({
      uuid: "image-uuid",
      toolName: "generateImage",
      message: "img",
      title: "Image",
      data: {},
    });
    applySkillEvent(session, skillPayload);
    assert.equal(session.toolResults.length, 2);
    const [, skillCard] = session.toolResults;
    assert.ok(skillCard);
    assert.equal(skillCard.toolName, "skill");
  });

  it("populates the envelope's `data` with all skill metadata", () => {
    const streamed = makeTextResult("partial body", "assistant");
    session.toolResults.push(streamed);
    applySkillEvent(session, skillPayload);
    const [card] = session.toolResults;
    assert.ok(card);
    const data = card.data as Record<string, unknown>;
    assert.equal(data.skillName, "mc-library");
    assert.equal(data.skillScope, "project");
    assert.equal(data.skillDescription, "Personal book journal");
    assert.equal(data.body, skillPayload.message);
  });

  // Codex iter-3 review on PR #1220 — when applySkillEvent falls
  // through to the push branch (no streamed assistant text-response
  // to replace), the new skill card MUST become the selected canvas
  // result. Without selection it would sit invisible in the canvas
  // and the user would have to manually click the chat-history
  // sidebar entry to view it.
  it("auto-selects the new skill card on the fallback push path", () => {
    const userText = makeTextResult("hi", "user");
    session.toolResults.push(userText);
    session.runStartIndex = 1;
    applySkillEvent(session, skillPayload);
    assert.equal(session.toolResults.length, 2);
    const [, skillCard] = session.toolResults;
    assert.ok(skillCard);
    assert.equal(session.selectedResultUuid, skillCard.uuid);
  });
});
