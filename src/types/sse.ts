// Server-sent events delivered by `POST /api/agent`. The frontend
// reads these off the SSE stream and dispatches into the active
// session's state.

import type { ToolResultComplete } from "gui-chat-protocol/vue";
import { EVENT_TYPES, type GenerationKind } from "./events";
import type { SkillScope } from "./session";

export interface SseToolCall {
  type: typeof EVENT_TYPES.toolCall;
  toolUseId: string;
  toolName: string;
  args: unknown;
}

export interface SseToolCallResult {
  type: typeof EVENT_TYPES.toolCallResult;
  toolUseId: string;
  content: string;
  /** Set when the tool-result block carried `is_error: true` —
   *  forwarded from `AgentEvent.toolCallResult.isError` so the
   *  frontend can render the chip distinctly. Drives the MCP
   *  failure monitor (#1353). */
  isError?: boolean;
}

export interface SseStatus {
  type: typeof EVENT_TYPES.status;
  message: string;
}

export interface SseText {
  type: typeof EVENT_TYPES.text;
  message: string;
  source?: "user" | "assistant";
  // Workspace-relative paths attached to this user turn. Forwarded
  // verbatim from the server's user-text broadcast so observing tabs
  // can render attachment chips matching the originating tab. Only
  // populated when `source === "user"`.
  attachments?: string[];
}

export interface SseToolResult {
  type: typeof EVENT_TYPES.toolResult;
  result: ToolResultComplete;
}

/** Broadcast when the server's text-accumulator flushes a body that
 *  followed a `Skill` tool_call. Lets observing tabs replace the
 *  streamed assistant-text bubble with a collapsed skill card live,
 *  without waiting for a session reload. (#1218) */
export interface SseSkill {
  type: typeof EVENT_TYPES.skill;
  source: "assistant";
  skillName: string;
  skillScope: SkillScope;
  skillPath: string | null;
  skillDescription: string | null;
  message: string;
}

export interface SseRolesUpdated {
  type: typeof EVENT_TYPES.rolesUpdated;
}

export interface SseError {
  type: typeof EVENT_TYPES.error;
  message: string;
}

/** Sent on the session channel when the agent run finishes. */
export interface SseSessionFinished {
  type: typeof EVENT_TYPES.sessionFinished;
}

/**
 * Plugin-initiated background work (e.g. MulmoScript image / audio /
 * movie render) started. The client records this in
 * `session.pendingGenerations` so the sidebar busy indicator stays
 * lit even when the originating view isn't mounted.
 */
export interface SseGenerationStarted {
  type: typeof EVENT_TYPES.generationStarted;
  kind: GenerationKind;
  filePath: string;
  key: string;
}

/** Companion event to `SseGenerationStarted` — the work completed
 *  (or failed; `error` populated). */
export interface SseGenerationFinished {
  type: typeof EVENT_TYPES.generationFinished;
  kind: GenerationKind;
  filePath: string;
  key: string;
  error?: string;
}

export type SseEvent =
  | SseToolCall
  | SseToolCallResult
  | SseStatus
  | SseText
  | SseSkill
  | SseToolResult
  | SseRolesUpdated
  | SseError
  | SseSessionFinished
  | SseGenerationStarted
  | SseGenerationFinished;
