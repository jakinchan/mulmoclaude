// Validator for the agent event stream. Events reach the client as
// `unknown` off the pub/sub socket and are then applied straight onto
// `ActiveSession` state that the canvas renders, so each variant is
// rebuilt from checked fields instead of asserted into `SseEvent`.

import type { ToolResultComplete } from "gui-chat-protocol/vue";
import { EVENT_TYPES, GENERATION_KINDS } from "../../types/events";
import type { PersistedAttachment } from "../../types/attachment";
import type { SkillScope } from "../../types/session";
import type { SseEvent, SseGenerationFinished, SseGenerationStarted, SseSkill, SseText, SseToolCall, SseToolCallResult, SseToolResult } from "../../types/sse";
import { isRecord, isUnknownArray } from "../types";

const isOptionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";
const isOptionalBoolean = (value: unknown): value is boolean | undefined => value === undefined || typeof value === "boolean";
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isSkillScope = (value: unknown): value is SkillScope => value === "user" || value === "project" || value === "unknown";
const isTextSource = (value: unknown): value is SseText["source"] => value === undefined || value === "user" || value === "assistant";
const isGenerationKind = (value: unknown): value is (typeof GENERATION_KINDS)[keyof typeof GENERATION_KINDS] =>
  Object.values(GENERATION_KINDS).some((kind) => kind === value);

// Returns a one-element list on success and an empty one on rejection, so the
// caller can flat-map and still count how many entries survived.
const parseAttachment = (value: unknown): PersistedAttachment[] => {
  if (typeof value === "string") return [value];
  if (!isRecord(value) || typeof value.path !== "string") return [];
  return [typeof value.filename === "string" ? { path: value.path, filename: value.filename } : { path: value.path }];
};

// Absent (rather than empty) on a malformed list, so a broken attachment
// can't quietly erase the chips the rest of the turn carries.
const parseAttachments = (value: unknown): PersistedAttachment[] | undefined => {
  if (!isUnknownArray(value)) return undefined;
  const parsed = value.flatMap(parseAttachment);
  return parsed.length === value.length ? parsed : undefined;
};

// Spread-then-override keeps fields the protocol doesn't declare but the
// host reads (the sidebar's `action` label); the declared ones are checked.
const parseToolResult = (value: unknown): ToolResultComplete | null => {
  if (!isRecord(value)) return null;
  const { toolName, uuid, title, message, instructions, instructionsRequired, updating, cancelled, viewState } = value;
  if (typeof toolName !== "string" || typeof uuid !== "string") return null;
  if (!isOptionalString(title) || !isOptionalString(message) || !isOptionalString(instructions)) return null;
  if (!isOptionalBoolean(instructionsRequired) || !isOptionalBoolean(updating) || !isOptionalBoolean(cancelled)) return null;
  if (viewState !== undefined && !isRecord(viewState)) return null;
  // `message` is declared required but plugins post results without one;
  // every consumer already reads it as `message ?? ""`.
  return { ...value, toolName, uuid, message: message ?? "" };
};

const parseToolCall = (value: Record<string, unknown>): SseToolCall | null => {
  const { toolUseId, toolName, args } = value;
  if (typeof toolUseId !== "string" || typeof toolName !== "string") return null;
  return { type: EVENT_TYPES.toolCall, toolUseId, toolName, args };
};

const parseToolCallResult = (value: Record<string, unknown>): SseToolCallResult | null => {
  const { toolUseId, content, isError } = value;
  if (typeof toolUseId !== "string" || typeof content !== "string" || !isOptionalBoolean(isError)) return null;
  return { type: EVENT_TYPES.toolCallResult, toolUseId, content, isError };
};

const parseText = (value: Record<string, unknown>): SseText | null => {
  const { message, source } = value;
  if (typeof message !== "string" || !isTextSource(source)) return null;
  return { type: EVENT_TYPES.text, message, source, attachments: parseAttachments(value.attachments) };
};

const parseSkill = (value: Record<string, unknown>): SseSkill | null => {
  const { skillName, skillScope, skillPath, skillDescription, message } = value;
  if (value.source !== "assistant" || typeof skillName !== "string" || typeof message !== "string") return null;
  if (!isSkillScope(skillScope) || !isNullableString(skillPath) || !isNullableString(skillDescription)) return null;
  return { type: EVENT_TYPES.skill, source: "assistant", skillName, skillScope, skillPath, skillDescription, message };
};

const parseGeneration = (value: Record<string, unknown>): Omit<SseGenerationStarted, "type"> | null => {
  const { kind, filePath, key } = value;
  if (!isGenerationKind(kind) || typeof filePath !== "string" || typeof key !== "string") return null;
  return { kind, filePath, key };
};

const parseGenerationStarted = (value: Record<string, unknown>): SseGenerationStarted | null => {
  const generation = parseGeneration(value);
  return generation ? { type: EVENT_TYPES.generationStarted, ...generation } : null;
};

const parseGenerationFinished = (value: Record<string, unknown>): SseGenerationFinished | null => {
  const generation = parseGeneration(value);
  if (!generation || !isOptionalString(value.error)) return null;
  return { type: EVENT_TYPES.generationFinished, ...generation, error: value.error };
};

const parseToolResultEvent = (value: Record<string, unknown>): SseToolResult | null => {
  const result = parseToolResult(value.result);
  return result ? { type: EVENT_TYPES.toolResult, result } : null;
};

/** Narrow a raw pub/sub payload to a known agent event, or null when it
 *  isn't one — unrecognised and malformed events are both ignored, which
 *  is what the dispatcher already did with an unmatched `type`. */
export function parseSseEvent(value: unknown): SseEvent | null {
  if (!isRecord(value)) return null;
  const { type, message } = value;
  switch (type) {
    case EVENT_TYPES.rolesUpdated:
    case EVENT_TYPES.sessionFinished:
      return { type };
    case EVENT_TYPES.status:
    case EVENT_TYPES.error:
      return typeof message === "string" ? { type, message } : null;
    case EVENT_TYPES.toolCall:
      return parseToolCall(value);
    case EVENT_TYPES.toolCallResult:
      return parseToolCallResult(value);
    case EVENT_TYPES.text:
      return parseText(value);
    case EVENT_TYPES.skill:
      return parseSkill(value);
    case EVENT_TYPES.toolResult:
      return parseToolResultEvent(value);
    case EVENT_TYPES.generationStarted:
      return parseGenerationStarted(value);
    case EVENT_TYPES.generationFinished:
      return parseGenerationFinished(value);
    default:
      return null;
  }
}
