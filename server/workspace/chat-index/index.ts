// Public entry point for the chat index. The agent route calls
// `maybeIndexSession({ sessionId, activeSessionIds })` from its
// `finally` block — fire-and-forget. This module:
//
//   - skips sessions still being written by a concurrent request
//   - holds a per-session lock so double-fires for the same id
//     become no-ops (two sessions can still index in parallel)
//   - catches ClaudeCliNotFoundError and disables itself for the
//     rest of the process lifetime to avoid spamming warnings
//   - catches unexpected errors and logs them so nothing bubbles
//     back into the request handler
//
// All functions accept an explicit `workspaceRoot` so tests can
// point at a `mkdtempSync` directory.

import { workspacePath as defaultWorkspacePath } from "../workspace.js";
import { ClaudeCliNotFoundError } from "../journal/archivist-cli.js";
import { indexSession, listSessionIds, type IndexerDeps } from "./indexer.js";
import { log } from "../../system/logger/index.js";
import { chatIndexMode as resolveChatIndexMode, loadSettings } from "../../system/config.js";

// Per-session lock. Indexing different sessions in parallel is
// fine; indexing the same session twice concurrently would just
// burn CLI budget for no benefit.
const running = new Set<string>();

// Flipped once we hit ENOENT on the `claude` CLI so we stop
// trying for the lifetime of the server process. Reset on
// restart.
let disabled = false;

export interface MaybeIndexSessionOptions {
  sessionId: string;
  // Skip indexing if the session is still being appended to by a
  // concurrent /api/agent request — the jsonl may be mid-write.
  // Ignored when `force` is true so manual rebuild runs can
  // re-index even a live session (accepting that the transcript
  // may be slightly out of date).
  activeSessionIds?: ReadonlySet<string>;
  workspaceRoot?: string | undefined;
  deps?: IndexerDeps | undefined;
  // Bypass the activeSessionIds guard and the isFresh throttle
  // for this call. The per-session lock and the `disabled`
  // sentinel are still respected — forcing doesn't help if the
  // claude CLI is missing or the same session is already in
  // flight.
  force?: boolean | undefined;
}

// Fire-and-forget entry point. Errors are swallowed here; a
// defensive `.catch(...)` at the call site is still recommended.
export async function maybeIndexSession(opts: MaybeIndexSessionOptions): Promise<void> {
  if (disabled) return;

  const { sessionId } = opts;
  const force = opts.force === true;
  if (!force && opts.activeSessionIds?.has(sessionId)) return;
  if (running.has(sessionId)) return;

  // Resolve chat-index mode from settings unless the caller passed one
  // explicitly (tests do; production callers don't). "off" short-
  // circuits before we take the per-session lock so a disabled
  // indexer stays a zero-work path.
  const mode = opts.deps?.mode ?? resolveChatIndexMode(loadSettings());
  if (mode === "off") return;

  // Thread `force` + `mode` through the indexer via IndexerDeps so the
  // freshness throttle is also bypassed on forced runs and the summarizer
  // picks the right model.
  const effectiveDeps: IndexerDeps = {
    ...(opts.deps ?? {}),
    ...(force ? { force: true } : {}),
    mode,
  };

  running.add(sessionId);
  try {
    await indexSession(opts.workspaceRoot ?? defaultWorkspacePath, sessionId, effectiveDeps);
  } catch (err) {
    if (err instanceof ClaudeCliNotFoundError) {
      disabled = true;
      log.warn("chat-index", err.message);
      return;
    }
    log.warn("chat-index", "unexpected failure, continuing", {
      error: String(err),
    });
  } finally {
    running.delete(sessionId);
  }
}

// Debug helper: index every session jsonl under workspace/chat/
// sequentially with `force: true`. Used by the manual rebuild
// endpoint and the CHAT_INDEX_FORCE_RUN_ON_STARTUP switch so the
// user can populate titles for existing sessions without waiting
// for each one to be revisited.
//
// Returns counts for logging. Errors on individual sessions do
// not stop the walk — the failure is logged and processing
// continues.
export interface BackfillResult {
  total: number;
  indexed: number;
  skipped: number;
}

// Index one session for the backfill walk, returning the outcome so the caller
// keeps ownership of the counters + the module-level `disabled` latch.
// Extracted to keep backfillAllSessions under the max-lines threshold; covered
// by test/chat-index/test_maybe_index_session.ts.
async function indexSessionForBackfill(
  workspaceRoot: string,
  sessionId: string,
  deps: IndexerDeps | undefined,
  force: boolean,
  mode: IndexerDeps["mode"],
): Promise<"indexed" | "skipped" | "disable"> {
  try {
    const entry = await indexSession(workspaceRoot, sessionId, { ...(deps ?? {}), ...(force ? { force: true } : {}), mode });
    if (entry) {
      log.info("chat-index", "indexed", { sessionId, title: entry.title });
      return "indexed";
    }
    return "skipped";
  } catch (err) {
    if (err instanceof ClaudeCliNotFoundError) {
      log.warn("chat-index", err.message);
      return "disable";
    }
    log.warn("chat-index", "failed to index", { sessionId, error: String(err) });
    return "skipped";
  }
}

export async function backfillAllSessions(
  opts: {
    workspaceRoot?: string | undefined;
    deps?: IndexerDeps | undefined;
    // Opt-in to "regenerate every summary, even those still current".
    // Default false — the scheduled tick uses that so unchanged
    // sessions cost only a stat + entry read, not a Claude CLI call.
    // The manual rebuild endpoint and CHAT_INDEX_FORCE_RUN_ON_STARTUP
    // opt in explicitly, matching their debug / rollout intent (#1929).
    force?: boolean | undefined;
  } = {},
): Promise<BackfillResult> {
  const workspaceRoot = opts.workspaceRoot ?? defaultWorkspacePath;
  // Resolve mode once for the whole walk (settings don't change mid-tick
  // and re-reading per session would burn ~N syscalls for no benefit).
  // "off" short-circuits the walk entirely — the sessions get counted
  // as skipped instead of paying for a listing.
  const mode = opts.deps?.mode ?? resolveChatIndexMode(loadSettings());
  if (mode === "off") {
    return { total: 0, indexed: 0, skipped: 0 };
  }
  const ids = await listSessionIds(workspaceRoot);
  const result: BackfillResult = {
    total: ids.length,
    indexed: 0,
    skipped: 0,
  };
  const force = opts.force === true;
  for (const sessionId of ids) {
    if (disabled) {
      result.skipped++;
      continue;
    }
    const outcome = await indexSessionForBackfill(workspaceRoot, sessionId, opts.deps, force, mode);
    if (outcome === "indexed") {
      result.indexed++;
    } else {
      result.skipped++;
      if (outcome === "disable") disabled = true;
    }
  }
  return result;
}

// Internal hook: tests need to reset the module-level `disabled`
// and `running` state between cases because node:test doesn't
// reload modules. Not part of the public runtime contract.
export function __resetForTests(): void {
  disabled = false;
  running.clear();
}
