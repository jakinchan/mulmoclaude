// Per-session client-side state and the on-disk envelope shapes
// returned by the server's session routes.

import type { ToolResultComplete } from "gui-chat-protocol/vue";
import { EVENT_TYPES, type PendingGeneration } from "./events";
import type { ToolCallHistoryItem } from "./toolCallHistory";

// ── Session origin (#486) ───────────────────────────────────

export const SESSION_ORIGINS = {
  human: "human",
  scheduler: "scheduler",
  skill: "skill",
  bridge: "bridge",
} as const;

/** Prefix for plugin-seeded sessions. `runtime.chat.start()` (Phase 1
 *  of the Encore plan) tags new sessions with `plugin:<pkg>` so the
 *  chat history can render the seeded first turn with a chip
 *  indicating which plugin started it. */
export const PLUGIN_SESSION_ORIGIN_PREFIX = "plugin:" as const;

/** Parse the pkg name out of a plugin-origin tag, or null if `origin`
 *  isn't a plugin tag. Matches `plugin:<pkg>` only — empty pkg names
 *  are rejected. */
export function pluginPkgFromOrigin(origin: string | undefined | null): string | null {
  if (typeof origin !== "string") return null;
  if (!origin.startsWith(PLUGIN_SESSION_ORIGIN_PREFIX)) return null;
  const pkg = origin.slice(PLUGIN_SESSION_ORIGIN_PREFIX.length);
  return pkg.length > 0 ? pkg : null;
}

export type SessionOrigin = (typeof SESSION_ORIGINS)[keyof typeof SESSION_ORIGINS] | `${typeof PLUGIN_SESSION_ORIGIN_PREFIX}${string}`;

const VALID_FIXED_ORIGINS: ReadonlySet<string> = new Set(Object.values(SESSION_ORIGINS));

export function isSessionOrigin(value: unknown): value is SessionOrigin {
  if (typeof value !== "string") return false;
  if (VALID_FIXED_ORIGINS.has(value)) return true;
  return pluginPkgFromOrigin(value) !== null;
}

// Server `/api/sessions` summary. Optional `summary` and `keywords`
// are populated by the chat indexer (#123) when present.
//
// `updatedAt` is the most recent activity timestamp — taken from the
// jsonl file's mtime on the server side and bumped whenever the
// client appends a message in-memory. Used for the "most recently
// touched" sort order in the session history sidebar (users expect
// active sessions to float to the top, not to stay pinned in
// creation order).
export interface SessionSummary {
  id: string;
  roleId: string;
  startedAt: string;
  updatedAt: string;
  preview: string;
  summary?: string;
  keywords?: string[];
  /** Where this session originated. Missing = "human" (backward compat). */
  origin?: SessionOrigin;
  /** User-set bookmark flag. Persisted in the meta sidecar. */
  isBookmarked?: boolean;
  // Live state from the server session store (present when the
  // session has an active in-memory entry on the server).
  //
  // `isRunning` — broad: agent turn live OR background generation
  // pending. Drives the sidebar busy indicator.
  // `liveIsRunning` — narrow: mirrors the DELETE 409 gate exactly
  // (#1195). `false` ⇒ a DELETE on this session will be accepted.
  isRunning?: boolean;
  liveIsRunning?: boolean;
  hasUnread?: boolean;
  statusMessage?: string;
}

// One line of a session jsonl as returned by `/api/sessions/:id`.
// Generic envelope; concrete narrowed shapes below.
export interface SessionEntry {
  type?: string;
  source?: string;
  roleId?: string;
  message?: string;
  result?: ToolResultComplete;
}

export interface TextEntry extends SessionEntry {
  source: "user" | "assistant";
  type: typeof EVENT_TYPES.text;
  message: string;
  // Workspace-relative paths the user attached for this turn. Persisted
  // alongside the text so the chat history can render attachment chips
  // after a session reload. Only present on user entries.
  attachments?: string[];
}

/** Where a skill resolution landed. Mirrors `SkillSource` from
 *  `server/workspace/skills/types.ts` (preset skills are synced into
 *  `<workspaceRoot>/.claude/skills/` at boot, so they surface as
 *  `project` here — discovery doesn't carry a separate `preset` tag).
 *  `unknown` covers the case where the skill went away between the
 *  tool call and the body flush. */
export type SkillScope = "user" | "project" | "unknown";

export interface SkillEntry extends SessionEntry {
  source: "assistant";
  type: typeof EVENT_TYPES.skill;
  /** Slug from `args.skill` of the preceding `Skill` tool_call. */
  skillName: string;
  skillScope: SkillScope;
  /** Absolute filesystem path to the SKILL.md, or null if the lookup
   *  missed (`skillScope === "unknown"`). */
  skillPath: string | null;
  /** SKILL.md frontmatter `description:` field, captured server-side
   *  from `discoverSkills()` because Claude CLI strips frontmatter
   *  before synthesising the body that lands in `message`. Null when
   *  the lookup missed. The host's collapsed-skill card displays this
   *  as the one-line summary. */
  skillDescription: string | null;
  /** Full SKILL.md body as Claude CLI synthesised it (frontmatter
   *  already stripped by Claude CLI; starts with the leading
   *  "Base directory for this skill: <path>" prefix and ends with
   *  the "ARGUMENTS: <user message>" footer). Kept for archival + the
   *  expand-on-click affordance in the canvas. */
  message: string;
}

export interface ToolResultEntry extends SessionEntry {
  source: "tool";
  type: typeof EVENT_TYPES.toolResult;
  result: ToolResultComplete;
}

export const isTextEntry = (entry: SessionEntry): entry is TextEntry =>
  (entry.source === "user" || entry.source === "assistant") && entry.type === EVENT_TYPES.text && typeof entry.message === "string";

export const isSkillEntry = (entry: SessionEntry): entry is SkillEntry =>
  entry.source === "assistant" && entry.type === EVENT_TYPES.skill && typeof entry.message === "string" && typeof (entry as SkillEntry).skillName === "string";

export const isToolResultEntry = (entry: SessionEntry): entry is ToolResultEntry =>
  entry.source === "tool" && entry.type === EVENT_TYPES.toolResult && entry.result !== undefined;

// In-memory session held in `sessionMap`. PR #88 introduced this so
// multiple chats can run concurrently — `id` matches the `chatSessionId`
// the server uses for the on-disk jsonl.
export interface ActiveSession {
  id: string;
  roleId: string;
  toolResults: ToolResultComplete[];
  /** UUID → epoch ms. Recorded when each result is added to the
   *  session — either from a real-time pubsub event or from
   *  loading a saved session. For saved sessions, the session's
   *  `startedAt` is used as a baseline (individual per-entry
   *  timestamps aren't persisted in the JSONL yet). */
  resultTimestamps: Map<string, number>;
  isRunning: boolean;
  statusMessage: string;
  toolCallHistory: ToolCallHistoryItem[];
  selectedResultUuid: string | null;
  hasUnread: boolean;
  startedAt: string;
  // Bumped whenever the user sends a new message in this session.
  // Used by `mergedSessions` to sort the sidebar history list by
  // "most recently touched" rather than "created first".
  updatedAt: string;
  // Index into `toolResults` at which the current run's outputs begin.
  // Rewritten on every user turn by `beginUserTurn`; consumed by
  // `shouldSelectAssistantText` to decide whether a trailing text
  // reply should become the selected canvas result. Lives on the
  // session (not on the subscription closure) so updates on turn N+1
  // are visible to the reused subscription callback.
  runStartIndex: number;
  /**
   * In-flight background generations triggered by a plugin view (e.g.
   * MulmoScript image/audio/movie renders). Keyed by
   * `generationKey(kind, filePath, key)` (opaque identity, not parsed
   * back); the value carries the decomposed (kind, filePath, key) so
   * views read those fields directly. Empty map = no background work.
   */
  pendingGenerations: Record<string, PendingGeneration>;
}
