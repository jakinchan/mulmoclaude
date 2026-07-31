// Pure session-mutation helpers extracted from App.vue.
// These operate on ActiveSession objects directly — no Vue
// reactivity, no imports from the component.

import { v4 as uuidv4 } from "uuid";
import type { ToolResultComplete } from "gui-chat-protocol/vue";
import type { ActiveSession, SkillScope } from "../../types/session";
import type { PersistedAttachment } from "../../types/attachment";
import { makeSkillResult, makeTextResult, SKILL_TOOL_NAME } from "../tools/result";
import { shouldSelectAssistantText } from "../agent/toolCalls";

/** Push a result and record its timestamp in one place. */
export function pushResult(session: ActiveSession, result: ToolResultComplete): void {
  session.toolResults.push(result);
  session.resultTimestamps.set(result.uuid, Date.now());
}

/** Surface a server/transport error as a visible card in the session. */
export function pushErrorMessage(session: ActiveSession, message: string): void {
  const text = `[Error] ${message}`;
  const errorResult: ToolResultComplete = {
    uuid: uuidv4(),
    toolName: "text-response",
    message: text,
    title: "Error",
    data: { text, role: "assistant", transportKind: "text-rest" },
  };
  pushResult(session, errorResult);
  session.selectedResultUuid = errorResult.uuid;
}

/** Append the user's message so it renders immediately. `attachments`
 *  carries the files the user attached for this turn (paste/drop/
 *  file-picker) so the chat bubble can render an icon / thumbnail chip
 *  alongside the text, labelled with the original filename when known. */
export function beginUserTurn(session: ActiveSession, message: string, attachments?: readonly PersistedAttachment[]): void {
  session.updatedAt = new Date().toISOString();
  pushResult(session, makeTextResult(message, "user", attachments));
  session.runStartIndex = session.toolResults.length;
}

/** Append text to the last assistant text-response if one exists.
 *  Returns true if appended, false if a new card is needed. */
export function appendToLastAssistantText(session: ActiveSession, text: string): boolean {
  const last = session.toolResults[session.toolResults.length - 1];
  const lastData = last?.data as { role?: string; text?: string } | undefined;
  if (last?.toolName !== "text-response" || lastData?.role !== "assistant") {
    return false;
  }
  lastData.text = (lastData.text ?? "") + text;
  last.message = (last.message ?? "") + text;
  return true;
}

/** Check if an incoming user text event is a duplicate of the last
 *  user message (sent by this tab via beginUserTurn). */
function isDuplicateUserText(session: ActiveSession, message: string): boolean {
  const last = session.toolResults[session.toolResults.length - 1];
  const lastData = last?.data as { role?: string; text?: string } | undefined;
  return last?.toolName === "text-response" && lastData?.role === "user" && lastData?.text === message;
}

/** Handle an incoming text event (user or assistant) from the
 *  agent's SSE/pubsub stream. Deduplicates user messages,
 *  streams assistant text into the last card, and selects the
 *  result when appropriate. `attachments` is forwarded for cross-tab
 *  user-text broadcasts so observing tabs render chips identically
 *  to the originating tab. */
export function applyTextEvent(session: ActiveSession, message: string, source: "user" | "assistant", attachments?: readonly PersistedAttachment[]): void {
  if (source === "user") {
    if (!isDuplicateUserText(session, message)) {
      pushResult(session, makeTextResult(message, "user", attachments));
      session.runStartIndex = session.toolResults.length;
    }
    return;
  }
  // A tool call since the last delta closes the prior text block, so
  // skip the append and open a fresh card (matches the per-block split
  // a reloaded session produces). Otherwise stream deltas of the same
  // block onto the tail card.
  if (!session.assistantTextInterrupted && appendToLastAssistantText(session, message)) return;
  session.assistantTextInterrupted = false;
  const textResult = makeTextResult(message, "assistant");
  pushResult(session, textResult);
  if (shouldSelectAssistantText(session.toolResults, session.runStartIndex)) {
    session.selectedResultUuid = textResult.uuid;
  }
}

/** Replace the trailing assistant text-response (the streamed skill
 *  body from Claude CLI) with a collapsed skill card, preserving the
 *  uuid so any view bound to that uuid (selection, scroll anchors)
 *  doesn't lose its handle. Falls back to pushing a fresh skill
 *  card if no assistant text-response is at the tail (e.g. flush
 *  fired with no streamed deltas, or another result snuck in
 *  between).  #1218 */
export function applySkillEvent(
  session: ActiveSession,
  payload: {
    skillName: string;
    skillScope: SkillScope;
    skillPath: string | null;
    skillDescription: string | null;
    message: string;
  },
): void {
  const last = session.toolResults[session.toolResults.length - 1];
  const lastData = last?.data as { role?: string } | undefined;
  if (last?.toolName === "text-response" && lastData?.role === "assistant") {
    const replacement = makeSkillResult(payload);
    // Preserve uuid so selection / scroll anchors don't blink off.
    Object.assign(last, { ...replacement, uuid: last.uuid });
    return;
  }
  const skillResult = makeSkillResult(payload);
  pushResult(session, skillResult);
  if (shouldSelectAssistantText(session.toolResults, session.runStartIndex)) {
    session.selectedResultUuid = skillResult.uuid;
  }
}

// Re-export so callers don't need to import from `tools/result` for
// the tool-name comparison constant.
export { SKILL_TOOL_NAME };

/** In-place update a result that was re-emitted by a plugin view
 *  (e.g. after the user edits a chart config). */
export function updateResult(session: ActiveSession, updatedResult: ToolResultComplete): void {
  const index = session.toolResults.findIndex((result) => result.uuid === updatedResult.uuid);
  if (index !== -1) {
    Object.assign(session.toolResults[index], updatedResult);
  }
}

/** Handle an incoming tool_result event: upsert into the session's
 *  result list. Selects the result on insert; in-place updates
 *  preserve the user's current selection. The MCP bridge skips the
 *  toolResult POST for narrate-only actions (handlers that omit
 *  `data`), so every result that reaches this function is intended
 *  to surface a card. */
export function applyToolResultToSession(session: ActiveSession, result: ToolResultComplete): void {
  const idx = session.toolResults.findIndex((existing) => existing.uuid === result.uuid);
  if (idx >= 0) {
    session.toolResults[idx] = result;
  } else {
    pushResult(session, result);
    session.selectedResultUuid = result.uuid;
  }
}
