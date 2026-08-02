// Pure helpers for relay-client.ts.
//
// Everything here is input → output with no socket / network / timer /
// I/O and no closure-state mutation, so it can be unit-tested in
// isolation. The stateful WebSocket + reconnect wiring stays in
// relay-client.ts.

import type { ChatService } from "@mulmobridge/chat-service";
import { isRecord } from "../utils/types.js";

export interface RelayMessage {
  id: string;
  platform: string;
  senderId: string;
  chatId: string;
  text: string;
  receivedAt: string;
  replyToken?: string | undefined;
}

type RelayResult = Awaited<ReturnType<ChatService["relay"]>>;

// Close codes that indicate a permanent/terminal error — no point
// reconnecting until the configuration is fixed.
const TERMINAL_CLOSE_CODES = new Set([
  1008, // Policy violation (e.g. auth rejected)
  4401, // Custom: unauthorized
  4403, // Custom: forbidden
]);

export function buildRelayUrl(relayUrl: string, relayToken: string): string {
  const url = new URL(relayUrl);
  url.searchParams.set("token", relayToken);
  return url.toString();
}

export function nextReconnectMs(currentMs: number, maxMs: number): number {
  return Math.min(currentMs * 2, maxMs);
}

export function isTerminalCloseCode(code: number): boolean {
  return TERMINAL_CLOSE_CODES.has(code);
}

// Double-underscore separator avoids collisions — platform names are
// from a fixed set (PLATFORMS constant) and none contain "__". Single
// "-" is unsafe because "google-chat" + "X" collides with "google" +
// "chat-X".
export function buildExternalChatId(platform: string, chatId: string): string {
  return `${platform}__${chatId}`;
}

export function isRelayMessage(value: unknown): value is RelayMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.platform === "string" &&
    typeof value.chatId === "string" &&
    typeof value.text === "string" &&
    value.text !== "" &&
    value.chatId !== ""
  );
}

export function formatReplyText(result: RelayResult): string {
  return result.kind === "ok" ? result.reply : `Error: ${result.message}`;
}
