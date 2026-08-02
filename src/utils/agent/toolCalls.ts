// Pure helpers for the agent's tool-call history manipulation
// pulled out of `src/App.vue#sendMessage`. Each function is
// single-purpose, testable in isolation, and side-effect-free.
//
// Extracted as part of the cognitive-complexity refactor tracked
// in #175.

import type { ToolCallHistoryItem } from "../../types/toolCallHistory";
import type { SseToolCall } from "../../types/sse";
import type { ToolResultComplete } from "gui-chat-protocol/vue";
// `TEXT_LIKE_RESULT_TOOL_NAMES` resolves to `TOOL_NAMES.textResponse`
// + `TOOL_NAMES.skill` (the centralised constants main switched to),
// so this single import covers the Codex iter-3 "skill is text-like"
// fix AND main's "stop using string literals for tool names" cleanup
// in the merge of #1220 ↔ origin/main.
import { TEXT_LIKE_RESULT_TOOL_NAMES } from "../tools/result";

// Convert an SSE tool_call event into a ToolCallHistoryItem ready
// to push onto a session's toolCallHistory. Pure.
export function toToolCallEntry(event: SseToolCall): ToolCallHistoryItem {
  return {
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    args: event.args,
    timestamp: Date.now(),
  };
}

// When an SSE `tool_call_result` event arrives, the server tells
// us which tool call it belongs to via `toolUseId`. Find the most
// recent matching history entry that's still **pending** (no
// result, no error) and return it so the caller can attach the
// payload.
//
// Newest-first: scanning in reverse is intentional — two calls to
// the same tool within one run would otherwise attach the new
// result to the earlier entry. Reverse scan always picks the
// freshest pending entry, matching the server's LIFO ordering.
//
// Returns `undefined` when no pending call matches (race / retry /
// late-arriving event). Pure.
export function findPendingToolCall(history: readonly ToolCallHistoryItem[], toolUseId: string): ToolCallHistoryItem | undefined {
  return [...history].reverse().find((entry) => entry.toolUseId === toolUseId && entry.result === undefined && entry.error === undefined);
}

// Decide whether a newly-arrived assistant text message should
// become the selected canvas result. Rule: yes, iff no plugin
// tool result has landed during this run. A plugin result — e.g.
// an image, a todo list update — is visually richer than a bare
// text response and should stay selected once emitted.
//
// `runStartIndex` is the index into `toolResults` at which the
// current run's outputs begin. Results before that index belong
// to previous turns and don't count.
//
// Pure — returns a boolean for the caller to act on.
export function shouldSelectAssistantText(toolResults: readonly ToolResultComplete[], runStartIndex: number): boolean {
  return toolResults.slice(runStartIndex).every((result) => TEXT_LIKE_RESULT_TOOL_NAMES.has(result.toolName));
}
