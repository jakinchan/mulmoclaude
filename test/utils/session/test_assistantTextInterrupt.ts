// Regression for the single-pane "last message not selected" bug.
//
// Assistant text streams as deltas; native Bash/Read/Write tool calls
// route to `toolCallHistory`, never `toolResults`. Before the fix,
// `appendToLastAssistantText` glued every post-tool text block onto the
// first assistant card — one merged card whose selection anchored at its
// first line, so a trailing summary never became the selected canvas
// result in single-pane mode. The fix breaks the card at each tool-call
// boundary (via `ActiveSession.assistantTextInterrupted`) so the live
// stream matches the per-block split a reloaded session produces.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTextEvent } from "../../../src/utils/session/sessionHelpers.js";
import { createEmptySession } from "../../../src/utils/session/sessionFactory.js";
import type { ActiveSession } from "../../../src/types/session.js";

// Mirror the dispatcher's toolCall side effect without importing the
// whole SSE machinery: a tool call closes the open text block.
function toolCall(session: ActiveSession): void {
  session.assistantTextInterrupted = true;
}

function beginTurn(session: ActiveSession, message: string): void {
  applyTextEvent(session, message, "user");
  session.runStartIndex = session.toolResults.length;
}

function assistantTexts(session: ActiveSession): string[] {
  return session.toolResults
    .filter((result) => result.toolName === "text-response" && (result.data as { role?: string }).role === "assistant")
    .map((result) => (result.data as { text?: string }).text ?? "");
}

describe("applyTextEvent — tool calls split assistant text into separate cards", () => {
  it("merges consecutive deltas of the same block but splits across a tool call", () => {
    const session = createEmptySession("s1", "investor");
    beginTurn(session, "Build my portfolio");

    // Block 1 streams as two deltas, then a tool call, then block 2.
    applyTextEvent(session, "I'll create ", "assistant");
    applyTextEvent(session, "the collection.", "assistant");
    toolCall(session);
    applyTextEvent(session, "Now the holdings.", "assistant");

    const texts = assistantTexts(session);
    assert.deepEqual(texts, ["I'll create the collection.", "Now the holdings."]);
  });

  it("selects the final post-tool text card (the trailing summary)", () => {
    const session = createEmptySession("s2", "investor");
    beginTurn(session, "Build my portfolio");

    applyTextEvent(session, "I'll create the collection.", "assistant");
    toolCall(session);
    applyTextEvent(session, "Now the holdings.", "assistant");
    toolCall(session);
    applyTextEvent(session, "Your portfolio is live: total $119,157.", "assistant");

    const last = session.toolResults[session.toolResults.length - 1];
    assert.ok(last);
    assert.equal((last.data as { text?: string }).text, "Your portfolio is live: total $119,157.");
    // Single-pane canvas follows `selectedResultUuid` — it must land on
    // the summary, not the first "I'll create…" card.
    assert.equal(session.selectedResultUuid, last.uuid);
  });

  it("still streams uninterrupted deltas into one card", () => {
    const session = createEmptySession("s3", "investor");
    beginTurn(session, "Hi");

    applyTextEvent(session, "Hello ", "assistant");
    applyTextEvent(session, "there ", "assistant");
    applyTextEvent(session, "friend.", "assistant");

    assert.deepEqual(assistantTexts(session), ["Hello there friend."]);
  });
});
