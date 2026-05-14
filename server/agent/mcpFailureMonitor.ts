// Runtime failure monitor for external MCP servers (#1353).
//
// `mcpPreflight.ts` (#1352) handles the static case: servers that
// can't even start because of missing required config. This module
// handles the dynamic case: servers that start OK but fail to answer
// tool calls (API key rotated, upstream down, OAuth scope wrong …).
//
// Signal source is `tool_result.is_error: true` from Claude Code's
// stream-json. `stream.ts` now forwards that flag as
// `AgentEvent.toolCallResult.isError`; this monitor consumes those
// events, attributes errors to the originating MCP server (parsed
// from `mcp__<server>__<tool>` names cached at toolCall time), and
// fires a single warn + bell notification per server once a
// consecutive-failure threshold is crossed.
//
// What the monitor intentionally does NOT do:
//   - Restart the MCP server (operator's call).
//   - Capture MCP subprocess stderr (Claude Agent SDK holds that —
//     out of scope for #1353).
//   - Auto-dismiss the bell entry when calls recover. The notification
//     engine has no dismissal API exposed yet; future work can wire
//     it once that lands. For now: bell stays until user dismisses.

import { EVENT_TYPES } from "../../src/types/events.js";
import { NOTIFICATION_ACTION_TYPES, NOTIFICATION_PRIORITIES } from "../../src/types/notification.js";
import { publishNotification } from "../events/notifications.js";
import { log } from "../system/logger/index.js";

export const MCP_FAILURE_THRESHOLD = 3;

// Server-id contract — mirrors `isMcpServerId` in
// `server/system/config.ts`. Single `_` is allowed; consecutive
// `__` is forbidden because it would collide with the
// `mcp__<server>__<tool>` delimiter and make the parser ambiguous
// (Codex iter-2 on #1356). Both ends agreeing on this shape is
// what lets the monitor attribute failures back to the right
// server entry in `mcp.json`.
const MCP_SERVER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MCP_PREFIX = "mcp__";
const MCP_DELIM = "__";

function isValidServerId(value: string): boolean {
  return MCP_SERVER_ID_PATTERN.test(value) && !value.includes("__");
}

/** Minimal AgentEvent surface the monitor needs. Defined locally to
 *  avoid a circular import; structurally matches the relevant fields
 *  on the real `AgentEvent` union. */
interface TrackableEvent {
  type: string;
  toolUseId?: string;
  toolName?: string;
  content?: string;
  isError?: boolean;
}

interface ServerStats {
  consecutiveFailures: number;
  totalFailures: number;
  totalCalls: number;
}

interface NotificationSink {
  publish: typeof publishNotification;
  warn: (event: string, message: string, data?: Record<string, unknown>) => void;
}

const defaultSink: NotificationSink = {
  publish: publishNotification,
  warn: (event, message, data) => log.warn(event, message, data),
};

/** Pure helper: returns the server id encoded in an MCP tool name,
 *  or `null` for non-MCP tools.
 *
 *  Parses by string-split rather than a single regex so:
 *    - server ids containing `_` (allowed by `isMcpServerId`, e.g.
 *      `a1_b2`) attribute correctly. The first `__` after the
 *      `mcp__` prefix is treated as the server↔tool delimiter, so
 *      `mcp__a1_b2__do_thing` resolves to server `"a1_b2"`,
 *      tool-part `"do_thing"`.
 *    - no regex backtracking surface (Codex flagged ReDoS on the
 *      previous `[^_]+(?:_[^_]+)*` form; this fix uses split + a
 *      simple per-character validator instead). */
export function mcpServerFromToolName(toolName: string): string | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null;
  const rest = toolName.slice(MCP_PREFIX.length);
  const delim = rest.indexOf(MCP_DELIM);
  if (delim <= 0) return null;
  const serverId = rest.slice(0, delim);
  // The tool-part is everything after the delimiter; it can carry
  // `__` of its own (some MCP authors use `__` in tool names) — we
  // only care that something is there.
  if (rest.length <= delim + MCP_DELIM.length) return null;
  return isValidServerId(serverId) ? serverId : null;
}

/** Build a session-scoped monitor. Returns the same shape as
 *  `createMcpTracker` so the backend wires both in the same loop.
 *
 *  `sink` is injectable for tests so we don't need to mock the
 *  notification engine / logger globally. */
export function createMcpFailureMonitor(opts: { sink?: NotificationSink; threshold?: number } = {}): {
  track: (event: TrackableEvent) => void;
} {
  const sink = opts.sink ?? defaultSink;
  const threshold = opts.threshold ?? MCP_FAILURE_THRESHOLD;
  const toolUseIdToServer = new Map<string, string>();
  const stats = new Map<string, ServerStats>();
  const notified = new Set<string>();

  function recordCall(toolUseId: string, toolName: string): void {
    const server = mcpServerFromToolName(toolName);
    if (server === null) return;
    toolUseIdToServer.set(toolUseId, server);
  }

  function recordResult(toolUseId: string, isError: boolean): void {
    const server = toolUseIdToServer.get(toolUseId);
    if (server === undefined) return; // not an MCP call (or orphan result)
    toolUseIdToServer.delete(toolUseId);
    const entry = stats.get(server) ?? { consecutiveFailures: 0, totalFailures: 0, totalCalls: 0 };
    entry.totalCalls += 1;
    if (isError) {
      entry.consecutiveFailures += 1;
      entry.totalFailures += 1;
      if (entry.consecutiveFailures >= threshold && !notified.has(server)) {
        notified.add(server);
        emitFailureNotice(server, entry, sink);
      }
    } else {
      entry.consecutiveFailures = 0;
    }
    stats.set(server, entry);
  }

  return {
    track(event: TrackableEvent): void {
      if (event.type === EVENT_TYPES.toolCall && typeof event.toolUseId === "string" && typeof event.toolName === "string") {
        recordCall(event.toolUseId, event.toolName);
      } else if (event.type === EVENT_TYPES.toolCallResult && typeof event.toolUseId === "string") {
        recordResult(event.toolUseId, event.isError === true);
      }
    },
  };
}

function emitFailureNotice(server: string, entry: ServerStats, sink: NotificationSink): void {
  const message = `MCP server ${server} returned errors on ${String(entry.consecutiveFailures)} consecutive tool calls; check API key, network, or upstream service health.`;
  sink.warn("mcp", "subprocess appears broken — consecutive tool errors crossed threshold", {
    server,
    consecutiveFailures: entry.consecutiveFailures,
    totalFailures: entry.totalFailures,
    totalCalls: entry.totalCalls,
  });
  sink.publish({
    // Deterministic id so the notification engine's legacyId dedup
    // matches across restarts — bell entries from previous boots
    // for the same broken server don't pile up.
    id: `mcp-failure-${server}`,
    kind: "system",
    title: "MCP server failing",
    body: message,
    action: { type: NOTIFICATION_ACTION_TYPES.none },
    priority: NOTIFICATION_PRIORITIES.high,
  });
}
