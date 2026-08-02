// Pure parsing helpers for the LINE bridge webhook.

export interface LineMessage {
  type: string;
  text?: string;
  /** LINE content id — present on media types (image / video / audio
   *  / file). The actual bytes live behind a separate Data API call
   *  (`/v2/bot/message/<id>/content`); the webhook only carries the
   *  reference. */
  id?: string;
}

export interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { userId?: string; type?: string };
  message?: LineMessage;
}

export interface LineWebhookBody {
  events: LineEvent[];
}

/** Discriminated union — the webhook may surface text or media.
 *  Callers branch on `kind` and either send text straight to chat
 *  or download the media bytes via the LINE Data API.
 *
 *  PR-C of #1222: image is the only media kind we forward today.
 *  Video / audio / file extend this union if/when they become
 *  worth fanning out to the agent. */
export type IncomingLineMessage = { kind: "text"; userId: string; text: string } | { kind: "image"; userId: string; imageMessageId: string };

/**
 * Reduce a LINE webhook event to the actionable shape. Returns null
 * for non-actionable events (non-message types, missing fields,
 * unsupported media). Pure — no side effects, no allowlist check.
 */
export function extractIncomingLineMessage(event: LineEvent): IncomingLineMessage | null {
  if (event.type !== "message") return null;
  const userId = event.source?.userId;
  if (!userId) return null;
  const { message } = event;
  if (!message) return null;
  if (message.type === "text") {
    const text = message.text ?? "";
    if (!text.trim()) return null;
    return { kind: "text", userId, text };
  }
  if (message.type === "image" && typeof message.id === "string" && message.id.length > 0) {
    return { kind: "image", userId, imageMessageId: message.id };
  }
  return null;
}

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === "string";

function isLineEventSource(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ("userId" in value && !isOptionalString(value.userId)) return false;
  return !("type" in value) || isOptionalString(value.type);
}

function isLineMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || typeof value.type !== "string") return false;
  if ("text" in value && !isOptionalString(value.text)) return false;
  return !("id" in value) || isOptionalString(value.id);
}

/** True only when every field `LineEvent` declares is present in the shape it
 *  declares. Extra platform fields we don't model are left untouched. */
function isLineEvent(value: unknown): value is LineEvent {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || typeof value.type !== "string") return false;
  if ("replyToken" in value && !isOptionalString(value.replyToken)) return false;
  if ("source" in value && value.source !== undefined && !isLineEventSource(value.source)) return false;
  return !("message" in value) || value.message === undefined || isLineMessage(value.message);
}

/** Best-effort JSON parse for the webhook body — null on malformed input.
 *  Events that don't match `LineEvent` are dropped rather than handed on as if
 *  they did: a `null` element used to throw inside the delivery loop. */
export function parseLineWebhookBody(raw: string): LineWebhookBody | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("events" in parsed)) return null;
    const { events } = parsed;
    return Array.isArray(events) ? { events: events.filter(isLineEvent) } : null;
  } catch {
    return null;
  }
}
