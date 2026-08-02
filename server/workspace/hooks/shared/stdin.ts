// Read the JSON PostToolUse payload Claude CLI streams on stdin.
// Returns the parsed payload or null when the input is empty /
// malformed — the dispatcher treats null as a fast no-op so a hook
// fired with no body never crashes the user's tool turn.

import { isRecord } from "../../../utils/types.js";

export interface HookPayload {
  tool_name?: unknown;
  tool_input?: {
    file_path?: unknown;
    command?: unknown;
    [key: string]: unknown;
  };
  tool_response?: {
    filePath?: unknown;
    [key: string]: unknown;
  };
  session_id?: unknown;
  [key: string]: unknown;
}

const isOptionalRecord = (value: unknown): boolean => value === undefined || isRecord(value);

// `tool_name` / `session_id` are declared `unknown`, so any value satisfies
// them; only the two nested objects carry a shape. Together with the trailing
// index signature that covers every field the interface declares.
function isHookPayload(value: unknown): value is HookPayload {
  return isRecord(value) && isOptionalRecord(value.tool_input) && isOptionalRecord(value.tool_response);
}

export async function readHookPayload(): Promise<HookPayload | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHookPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Different tools surface the path under different keys (Write/Edit
// use tool_input.file_path; the response shape uses filePath). The
// helper checks both defensively so handlers don't need to.
export function extractFilePath(payload: HookPayload): string {
  const fromInput = payload.tool_input?.file_path;
  if (typeof fromInput === "string") return fromInput;
  const fromResponse = payload.tool_response?.filePath;
  if (typeof fromResponse === "string") return fromResponse;
  return "";
}

// Bash tool calls put the shell command string in tool_input.command.
// Empty string when the payload is a non-Bash tool or malformed.
export function extractCommand(payload: HookPayload): string {
  const command = payload.tool_input?.command;
  return typeof command === "string" ? command : "";
}

export function extractToolName(payload: HookPayload): string {
  return typeof payload.tool_name === "string" ? payload.tool_name : "";
}

export function extractSessionId(payload: HookPayload): string | undefined {
  const sessionId = payload.session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}
