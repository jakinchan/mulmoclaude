// Unit-tests the `pendingSkill` state machine in isolation —
// `updatePendingSkillOnToolCall` + `updatePendingSkillOnToolCallResult`
// — to lock in the leak-fix invariants Codex flagged across two
// review iterations on PR #1220.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  updatePendingSkillOnToolCall as onToolCall,
  updatePendingSkillOnToolCallResult as onToolCallResult,
  recordPushReply,
  splitSkillAndReply,
  type PendingSkillSlot as MinimalCtx,
} from "../../server/agent/skillEvents.js";

describe("pendingSkill state machine (#1218)", () => {
  it("Skill tool_call sets pendingSkill with skillName + toolUseId", () => {
    const ctx: MinimalCtx = { pendingSkill: null };
    onToolCall(ctx, { toolName: "Skill", toolUseId: "tu_A", args: { skill: "shiritori" } });
    assert.deepEqual(ctx.pendingSkill, { skillName: "shiritori", toolUseId: "tu_A" });
  });

  it("Skill tool_call without a skill slug arg leaves pendingSkill null", () => {
    const ctx: MinimalCtx = { pendingSkill: null };
    onToolCall(ctx, { toolName: "Skill", toolUseId: "tu_A", args: {} });
    assert.equal(ctx.pendingSkill, null);
  });

  it("Codex iter-1 — non-Skill tool_call clears stale pendingSkill (Bash interleaving the body)", () => {
    const ctx: MinimalCtx = { pendingSkill: { skillName: "shiritori", toolUseId: "tu_A" } };
    onToolCall(ctx, { toolName: "Bash", toolUseId: "tu_B", args: { command: "ls" } });
    assert.equal(ctx.pendingSkill, null);
  });

  it("Codex iter-2 — Skill's own tool_call_result keeps pendingSkill set (matching id)", () => {
    const ctx: MinimalCtx = { pendingSkill: { skillName: "shiritori", toolUseId: "tu_A" } };
    onToolCallResult(ctx, "tu_A");
    assert.deepEqual(ctx.pendingSkill, { skillName: "shiritori", toolUseId: "tu_A" });
  });

  it("Codex iter-2 — tool_call_result with mismatched id clears pendingSkill (interleaved tool result)", () => {
    const ctx: MinimalCtx = { pendingSkill: { skillName: "shiritori", toolUseId: "tu_A" } };
    onToolCallResult(ctx, "tu_OTHER");
    assert.equal(ctx.pendingSkill, null);
  });

  it("tool_call_result is a no-op when nothing was pending", () => {
    const ctx: MinimalCtx = { pendingSkill: null };
    onToolCallResult(ctx, "tu_X");
    assert.equal(ctx.pendingSkill, null);
  });

  it("Re-issuing a Skill tool_call (e.g. user calls another skill) replaces the pending state", () => {
    const ctx: MinimalCtx = { pendingSkill: { skillName: "shiritori", toolUseId: "tu_A" } };
    onToolCall(ctx, { toolName: "Skill", toolUseId: "tu_B", args: { skill: "mc-library" } });
    assert.deepEqual(ctx.pendingSkill, { skillName: "mc-library", toolUseId: "tu_B" });
  });

  it("Sequence: Skill → matching result → Bash → unrelated text would not have pendingSkill set anymore", () => {
    const ctx: MinimalCtx = { pendingSkill: null };
    onToolCall(ctx, { toolName: "Skill", toolUseId: "tu_A", args: { skill: "shiritori" } });
    assert.ok(ctx.pendingSkill, "Skill set the flag");
    onToolCallResult(ctx, "tu_A");
    assert.ok(ctx.pendingSkill, "matching result keeps the flag — body still expected");
    onToolCall(ctx, { toolName: "Bash", toolUseId: "tu_B", args: {} });
    assert.equal(ctx.pendingSkill, null, "Bash interrupted — flag cleared");
  });
});

// The completion push (#2901) quotes the turn's last assistant text. A SKILL.md
// body can reach the flush as ASSISTANT text — the degradation path
// `flushTextAccumulator` documents — and there is a failure either side of the
// line: quoting the body puts a skill's whole instruction prompt on a lock
// screen, and quoting nothing drops a genuine answer the CLI emitted in the
// same burst. Both were caught on #2909, one iteration apart.
describe("recordPushReply — what the completion push may quote", () => {
  const SKILL_BODY = "# Shiritori\nTake turns naming words.";
  const skillBurst = (trailingReply: string) => `Base directory for this skill: /skills/shiritori\n${SKILL_BODY}\nARGUMENTS: none\n${trailingReply}`;
  // Exactly what `flushTextAccumulator` hands the recorder for a Skill burst.
  const userFacingPartOf = (burst: string) => splitSkillAndReply(burst, SKILL_BODY).replyPart;

  it("records a genuine assistant reply", () => {
    const slot = { lastAssistantText: "" };
    recordPushReply(slot, "Wrote 42 rows.");
    assert.equal(slot.lastAssistantText, "Wrote 42 rows.");
  });

  it("records nothing when a skill burst carries no reply of its own", () => {
    const slot = { lastAssistantText: "" };
    recordPushReply(slot, userFacingPartOf(skillBurst("")));
    assert.equal(slot.lastAssistantText, "");
  });

  it("records the reply the CLI emitted alongside the skill body", () => {
    const slot = { lastAssistantText: "" };
    recordPushReply(slot, userFacingPartOf(skillBurst("しりとりを始めます。最初は「りんご」。")));
    assert.equal(slot.lastAssistantText, "しりとりを始めます。最初は「りんご」。");
    assert.ok(!slot.lastAssistantText.includes("Base directory"));
    assert.ok(!slot.lastAssistantText.includes("Take turns"));
  });

  it("leaves an earlier reply standing rather than clearing it", () => {
    const slot = { lastAssistantText: "Starting the game." };
    recordPushReply(slot, userFacingPartOf(skillBurst("")));
    assert.equal(slot.lastAssistantText, "Starting the game.");
  });
});
