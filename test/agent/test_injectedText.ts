// The SKILL.md body must never parse to a `text` agent event (#2821).
//
// Claude CLI delivers it as a text block on a `user`-role message — context it
// injected, not assistant prose — while the assistant's reply arrives as
// `assistant` deltas. Collapsing both into `type: "text"` is what let SKILL.md
// bodies reach bridge replies, so this pins the distinction against REAL
// captured CLI output rather than a hand-written event list.
//
// The fixtures are `claude --output-format stream-json --input-format
// stream-json --include-partial-messages` runs (`system` / `rate_limit_event`
// lines and absolute paths stripped). If a future CLI version moves the body
// onto an assistant block, this suite fails — which is the point: that is the
// degradation path `flushTextAccumulator` still covers, and we want to know.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import nodeFs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStreamParser, blockToEvent, INJECTED_TEXT, type AgentEvent, type RawStreamEvent } from "../../server/agent/stream.js";
import { EVENT_TYPES } from "../../src/types/events.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SKILL_BODY_PREFIX = "Base directory for this skill: ";

function parseFixture(name: string): AgentEvent[] {
  const parser = createStreamParser();
  const raw = nodeFs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => parser.parse(JSON.parse(line) as RawStreamEvent));
}

const textMessages = (events: AgentEvent[]): string[] =>
  events.filter((event): event is Extract<AgentEvent, { type: typeof EVENT_TYPES.text }> => event.type === EVENT_TYPES.text).map((event) => event.message);

describe("blockToEvent — the message role decides what a text block is", () => {
  it("maps an assistant text block to a text event", () => {
    assert.deepEqual(blockToEvent({ type: "text", text: "hello" }, "assistant"), { type: EVENT_TYPES.text, message: "hello" });
  });

  it("maps a user text block to an injected-text event", () => {
    assert.deepEqual(blockToEvent({ type: "text", text: "hello" }, "user"), { type: INJECTED_TEXT, message: "hello" });
  });

  it("defaults to assistant so existing callers keep their meaning", () => {
    assert.deepEqual(blockToEvent({ type: "text", text: "hello" }), { type: EVENT_TYPES.text, message: "hello" });
  });

  it("leaves tool_result blocks alone regardless of role", () => {
    const block = { type: "tool_result", tool_use_id: "tu_1", content: "done" };
    assert.deepEqual(blockToEvent(block, "user"), { type: EVENT_TYPES.toolCallResult, toolUseId: "tu_1", content: "done" });
  });
});

describe("real CLI stream — a Skill turn", () => {
  const events = parseFixture("cli-stream-skill.jsonl");

  it("emits the SKILL.md body as injected text, in one event", () => {
    const injected = events.filter((event) => event.type === INJECTED_TEXT);
    assert.equal(injected.length, 1, "the body arrives whole, not as deltas");
    assert.ok(injected[0]);
    assert.ok(injected[0].message.startsWith(SKILL_BODY_PREFIX));
    assert.ok(injected[0].message.length > 8000, "fixture body is ~8.9k chars");
  });

  it("never puts the SKILL.md body in a text event", () => {
    const leaked = textMessages(events).filter((message) => message.includes(SKILL_BODY_PREFIX));
    assert.deepEqual(leaked, [], "a text event carrying the body is exactly the #2821 bridge bug");
  });

  it("still streams the assistant's own prose as text", () => {
    const joined = textMessages(events).join("");
    assert.ok(joined.includes("bigskill"), "the pre-tool-call preamble is assistant text");
    assert.ok(joined.includes("Tokyo"), "the post-skill reply is assistant text");
  });

  it("keeps the Skill tool call ahead of the body", () => {
    const skillCallIndex = events.findIndex((event) => event.type === EVENT_TYPES.toolCall && event.toolName === "Skill");
    const bodyIndex = events.findIndex((event) => event.type === INJECTED_TEXT);
    assert.ok(skillCallIndex >= 0 && bodyIndex > skillCallIndex, "pendingSkill is what tags the body");
  });
});

describe("real CLI stream — a turn with no Skill", () => {
  const events = parseFixture("cli-stream-no-skill.jsonl");

  it("emits no injected text at all", () => {
    assert.deepEqual(
      events.filter((event) => event.type === INJECTED_TEXT),
      [],
      "an ordinary tool result is a tool_result block, never a user text block",
    );
  });

  it("still reports the assistant's reply as text", () => {
    assert.ok(textMessages(events).join("").includes("Rome"));
  });
});
