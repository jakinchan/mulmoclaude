// Skill jsonl entries (#1218) round-trip through `parseSessionEntries`
// into `toolName: "skill"` envelopes — this is what makes the canvas
// render them via the skill plugin's collapsed View instead of the
// default text-response Vue.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSessionEntries } from "../../../src/utils/session/sessionEntries";
import type { SessionEntry } from "../../../src/types/session";
import { EVENT_TYPES } from "../../../src/types/events";

describe("parseSessionEntries — skill entries (#1218)", () => {
  const skillEntry: SessionEntry = {
    source: "assistant",
    type: EVENT_TYPES.skill,
    skillName: "mc-library",
    skillScope: "project",
    skillPath: "/Users/test/mulmoclaude/.claude/skills/mc-library/SKILL.md",
    skillDescription: "Personal book journal",
    message: "Base directory for this skill: ...\n\n# Personal book journal\n\n...",
  } as SessionEntry;

  it('dispatches a skill entry to a `toolName: "skill"` envelope', () => {
    const out = parseSessionEntries([skillEntry]);
    assert.equal(out.length, 1);
    const [envelope] = out;
    assert.ok(envelope);
    assert.equal(envelope.toolName, "skill");
  });

  it("preserves skill metadata in the envelope's `data` field", () => {
    const out = parseSessionEntries([skillEntry]);
    const [envelope] = out;
    assert.ok(envelope);
    const data = envelope.data as Record<string, unknown>;
    assert.equal(data.skillName, "mc-library");
    assert.equal(data.skillScope, "project");
    assert.equal(data.skillPath, "/Users/test/mulmoclaude/.claude/skills/mc-library/SKILL.md");
    assert.equal(data.skillDescription, "Personal book journal");
    // Full body archived in `data.body` for the View's expand toggle.
    assert.match(data.body as string, /^Base directory for this skill:/);
  });

  it("envelope's `message` falls back to skillName when description missing", () => {
    const noDesc: SessionEntry = { ...skillEntry, skillDescription: null } as SessionEntry;
    const out = parseSessionEntries([noDesc]);
    const [envelope] = out;
    assert.ok(envelope);
    assert.equal(envelope.message, "mc-library");
  });

  it("title is the prefixed skill name so chat-history previews are scannable", () => {
    const out = parseSessionEntries([skillEntry]);
    const [envelope] = out;
    assert.ok(envelope);
    assert.equal(envelope.title, "Skill: mc-library");
  });

  it('legacy `type:"text"` skill bodies (pre-#1218 sessions) stay text-response — no auto-detection by prefix', () => {
    // The user explicitly opted out of retroactive detection. A
    // pre-tagging session with the skill body sitting under
    // `type: "text"` should continue to render as a normal assistant
    // text bubble, even if its content starts with the Claude CLI
    // prefix. That behaviour gets verified here so a future drive-by
    // "let's also do retroactive detection" change doesn't slip in
    // without an explicit decision.
    const legacy: SessionEntry = {
      source: "assistant",
      type: EVENT_TYPES.text,
      message: "Base directory for this skill: /old\n\n# Personal book journal\n\n...",
    } as SessionEntry;
    const out = parseSessionEntries([legacy]);
    const [envelope] = out;
    assert.ok(envelope);
    assert.equal(envelope.toolName, "text-response");
  });

  it("invalid skill entry (missing skillName) doesn't reach the dispatcher branch", () => {
    const broken = {
      source: "assistant",
      type: EVENT_TYPES.skill,
      message: "body",
      // skillName missing — `isSkillEntry` returns false
    } as SessionEntry;
    const out = parseSessionEntries([broken]);
    // Falls through both isSkillEntry and isTextEntry (no message
    // typeof check fail because message is a string but type is wrong)
    // → produces no envelope. Verifies the type guard's strictness.
    assert.equal(out.length, 0);
  });
});
