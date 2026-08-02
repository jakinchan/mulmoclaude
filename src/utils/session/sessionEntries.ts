// Pure helpers for reconstructing an `ActiveSession`'s runtime
// shape from the `/api/sessions/:id` JSONL payload. Extracted from
// `src/App.vue#loadSession` so the parse / select / timestamp-
// resolution logic is unit-testable without mocking `fetch`.
//
// Tracks #175.

import { makeSkillResult, makeTextResult, TEXT_LIKE_RESULT_TOOL_NAMES } from "../tools/result";
import {
  isSessionOrigin,
  isSkillEntry,
  isTextEntry,
  isToolResultEntry,
  pluginPkgFromOrigin,
  type ActiveSession,
  type SessionEntry,
  type SessionOrigin,
  type SessionSummary,
} from "../../types/session";
import { EVENT_TYPES } from "../../types/events";
import { isRecord } from "../types";
import type { ToolResultComplete } from "gui-chat-protocol/vue";

// Pull origin off the `session_meta` row in the entries payload, if
// present. The on-disk meta is the source of truth; the server fills
// `SessionSummary.origin` from it but the summary fetch (`/api/sessions`)
// races with the per-session detail fetch (`/api/sessions/:id`) on
// first mount of `/chat/<id>`. Codex review on PR #1237 caught this:
// without an entries-side fallback, plugin-seeded chats opened
// directly via URL miss the chip until the user navigates away and
// back. Returns undefined when no meta row exists or its origin is
// missing / malformed.
function extractMetaOrigin(entries: readonly SessionEntry[]): SessionOrigin | undefined {
  for (const entry of entries) {
    if (entry.type === EVENT_TYPES.sessionMeta) {
      const candidate = isRecord(entry) ? entry.origin : undefined;
      return isSessionOrigin(candidate) ? candidate : undefined;
    }
  }
  return undefined;
}

// Walk the server's session entries and produce the flat
// `toolResults` array the client keeps in `ActiveSession`. Drops
// `session_meta` rows (they're metadata, not a result), converts
// text entries into tool-result-shaped envelopes via
// `makeTextResult`, and passes tool_result entries through verbatim.
//
// When the effective origin is a `plugin:<pkg>` tag (Phase 1 of the
// Encore plan), the FIRST user text entry is marked with
// `seededByPlugin` so the textResponse view renders a "from <pkg>"
// chip + muted background, indicating the seed message came from a
// plugin's `runtime.chat.start()` call rather than the user
// themselves. The effective origin prefers the explicit
// `sessionOrigin` argument (from the summary) and falls back to the
// `session_meta` row in `entries` so URL-loaded chats render the
// chip even before the summary fetch resolves.
export function parseSessionEntries(entries: readonly SessionEntry[], sessionOrigin?: SessionOrigin): ToolResultComplete[] {
  const effectiveOrigin = sessionOrigin ?? extractMetaOrigin(entries);
  const seedingPkg = pluginPkgFromOrigin(effectiveOrigin);
  let firstUserSeen = false;
  const out: ToolResultComplete[] = [];
  for (const entry of entries) {
    if (entry.type === EVENT_TYPES.sessionMeta) continue;
    if (isSkillEntry(entry)) {
      // Skill bodies are routed through the dedicated skill plugin
      // View (collapsed by default) so they don't dump a wall of
      // markdown into the canvas. #1218.
      out.push(makeSkillResult(entry));
    } else if (isTextEntry(entry)) {
      const tagThis = !firstUserSeen && entry.source === "user" && seedingPkg !== null;
      const seededBy = tagThis ? seedingPkg : undefined;
      if (entry.source === "user") firstUserSeen = true;
      out.push(makeTextResult(entry.message, entry.source, entry.attachments, seededBy ?? undefined));
    } else if (isToolResultEntry(entry)) {
      out.push(entry.result);
    }
  }
  return out;
}

// Pick the `selectedResultUuid` the session should restore to on
// fresh load: the most recent result in the conversation, whether
// it's a tool result or a text result. Returns null only when the
// list is empty.
export function resolveSelectedUuid(toolResults: readonly ToolResultComplete[]): string | null {
  return toolResults[toolResults.length - 1]?.uuid ?? null;
}

// Total character length of the STREAMED-TEXT card bodies. Only text and
// skill cards keep their running text in `message` (TEXT_LIKE_RESULT_TOOL_NAMES),
// and only those grow token-by-token — so only those can be truncated by a
// dropped socket.io frame while the card COUNT stays equal. Other cards
// (images, charts, …) carry their payload in `data`, arrive complete in one
// frame, and are caught by the card-count check — so they're excluded here to
// avoid a `message` diff on a non-streamed card skewing the decision (#2096,
// Sourcery review).
function streamedTextLength(results: readonly ToolResultComplete[]): number {
  return results.reduce((sum, result) => (TEXT_LIKE_RESULT_TOOL_NAMES.has(result.toolName) ? sum + (result.message?.length ?? 0) : sum), 0);
}

/** Decide whether a reconnect / finished catch-up should replace the
 *  client's in-memory transcript with the server's copy.
 *
 *  - Server has MORE cards → adopt (the client missed whole events).
 *  - Same card count but MORE total text on the server → adopt: a dropped
 *    socket.io frame truncated a streamed text card, so the counts match
 *    yet the last card's body is cut off (#2096). Card-count alone missed
 *    this, leaving "…理由によ" on screen until a reload.
 *  - Otherwise keep the client copy — never overwrite a richer or equal
 *    in-flight state with an equal-or-staler snapshot (the #1915 guard
 *    that stops a `session_finished` race from clobbering live events). */
export function shouldAdoptServerTranscript(serverResults: readonly ToolResultComplete[], clientResults: readonly ToolResultComplete[]): boolean {
  if (serverResults.length !== clientResults.length) {
    return serverResults.length > clientResults.length;
  }
  return streamedTextLength(serverResults) > streamedTextLength(clientResults);
}

// Decide the `startedAt` / `updatedAt` to seed the in-memory
// ActiveSession with. We prefer the server summary's timestamps
// so the restored session keeps its existing sidebar ordering;
// we fall through to the current clock only if the server
// summary is missing (e.g. freshly-created session that hasn't
// round-tripped through `/api/sessions` yet).
//
// Keeping this logic named lets the test suite pin the
// "updatedAt missing → fall back to startedAt" rule explicitly,
// which was previously a fragile `??` chain buried in loadSession.
export function resolveSessionTimestamps(serverSummary: SessionSummary | undefined, nowIso: string): { startedAt: string; updatedAt: string } {
  const startedAt = serverSummary?.startedAt ?? nowIso;
  const updatedAt = serverSummary?.updatedAt ?? startedAt;
  return { startedAt, updatedAt };
}

// Spread toolResults evenly between startedAt and updatedAt to
// approximate per-entry timestamps for sessions loaded from disk.
// Real-time results will overwrite with Date.now() via pushResult.
export function interpolateTimestamps(toolResults: readonly ToolResultComplete[], startedAt: string, updatedAt: string): Map<string, number> {
  const timestamps = new Map<string, number>();
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(updatedAt).getTime();
  toolResults.forEach((result, i) => {
    const frac = toolResults.length > 1 ? i / (toolResults.length - 1) : 0;
    timestamps.set(result.uuid, startMs + (endMs - startMs) * frac);
  });
  return timestamps;
}

// Build an ActiveSession from server-fetched entries + metadata.
// Pure — the caller is responsible for inserting into sessionMap
// and subscribing.
export function buildLoadedSession(opts: {
  id: string;
  entries: readonly SessionEntry[];
  defaultRoleId: string;
  serverSummary: SessionSummary | undefined;
  nowIso: string;
}): ActiveSession {
  const { id, entries, defaultRoleId, serverSummary, nowIso } = opts;
  const meta = entries.find((entry) => entry.type === EVENT_TYPES.sessionMeta);
  const roleId = meta?.roleId ?? defaultRoleId;
  const toolResults = parseSessionEntries(entries, serverSummary?.origin);
  const selectedResultUuid = resolveSelectedUuid(toolResults);
  const { startedAt, updatedAt } = resolveSessionTimestamps(serverSummary, nowIso);
  const resultTimestamps = interpolateTimestamps(toolResults, startedAt, updatedAt);

  return {
    id,
    roleId,
    toolResults,
    resultTimestamps,
    isRunning: serverSummary?.isRunning ?? false,
    statusMessage: serverSummary?.statusMessage ?? "",
    toolCallHistory: [],
    selectedResultUuid,
    hasUnread: serverSummary?.hasUnread ?? false,
    startedAt,
    updatedAt,
    runStartIndex: toolResults.length,
    assistantTextInterrupted: false,
    pendingGenerations: {},
  };
}
