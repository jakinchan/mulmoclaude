// Per-session indexing logic. `indexSession` summarizes a single
// session jsonl and writes both a per-session file and a manifest
// upsert to workspace/chat/index/. `readManifest` is a tiny helper
// the sessions route uses to join entries into its /api/sessions
// response.
//
// All functions take an explicit `workspaceRoot` so tests can point
// at a `mkdtempSync` directory without touching the real
// ~/mulmoclaude.

import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { defaultSummarize, loadJsonlInput, type SummarizeFn } from "./summarizer.js";
import { chatDirFor, indexEntryPathFor, manifestPathFor, sessionJsonlPathFor, sessionMetaPathFor } from "./paths.js";
import type { ChatIndexEntry, ChatIndexManifest } from "./types.js";
import { writeJsonAtomic } from "../../utils/files/index.js";
import { DEFAULT_ROLE_ID } from "../../../src/config/roles.js";
import { ONE_MINUTE_MS } from "../../utils/time.js";
import { isRecord } from "../../utils/types.js";

// Freshness throttle: a session whose existing index entry is
// newer than this is skipped. The 15-minute window is a compromise
// — long enough that a single conversation doesn't re-summarize
// every turn, short enough that a user who leaves for lunch and
// comes back sees the title refresh.
//
// Complementary to the content-change gate below: `isFresh` says
// "we JUST indexed, don't retry mid-conversation", while
// `sessionJsonlChangedSinceIndex` says "the jsonl hasn't been
// touched since we last indexed, no work to do". Both run when
// `force` is false; `force: true` bypasses both.
export const MIN_INDEX_INTERVAL_MS = 15 * ONE_MINUTE_MS;

// Injection points for tests. Defaults are the production spawn +
// wall-clock.
export interface IndexerDeps {
  summarize?: SummarizeFn;
  now?: () => number;
  minIntervalMs?: number;
  // Bypass both the `isFresh` freshness throttle AND the content-
  // changed gate (`sessionJsonlChangedSinceIndex`). Used by the
  // manual rebuild endpoint and the `CHAT_INDEX_FORCE_RUN_ON_STARTUP`
  // startup path so "regenerate everything" semantics keep working
  // even when the summariser is unchanged — e.g. the summariser
  // prompt was edited and existing summaries are stale by design,
  // not by content.
  force?: boolean;
  // Chat-index mode from `AppSettings.chatIndex` (default "off"). "off"
  // short-circuits `indexSession` before any I/O; "haiku"/"sonnet"
  // selects the model passed to the summariser. Injected from the
  // callers (turn-finish hook, backfill scheduler, manual rebuild,
  // startup force) so a single settings load happens at trigger time
  // rather than N times inside the indexer.
  mode?: "off" | "haiku" | "sonnet";
}

// --- manifest I/O ---------------------------------------------------

export async function readManifest(workspaceRoot: string): Promise<ChatIndexManifest> {
  try {
    const raw = await readFile(manifestPathFor(workspaceRoot), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isManifest(parsed)) return parsed;
    return { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function isManifest(raw: unknown): raw is ChatIndexManifest {
  if (!isRecord(raw)) return false;
  return raw.version === 1 && Array.isArray(raw.entries);
}

// In-process mutex serializing the read-modify-write sequence on
// the shared manifest file. Two concurrent `indexSession` calls
// for different session ids would otherwise both read an empty
// manifest, each append their own entry, and the last writer would
// clobber the first. Chain-based mutex keeps it simple and fits
// this module's single-process assumption.
let manifestMutex: Promise<void> = Promise.resolve();

async function withManifestLock<T>(lockedFn: () => Promise<T>): Promise<T> {
  const prev = manifestMutex;
  let release: () => void = () => {};
  manifestMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await prev;
    return await lockedFn();
  } finally {
    release();
  }
}

// Atomic write: stage to a per-call unique tmp file and rename.
// The unique suffix is belt-and-suspenders — the mutex above
// already serializes callers within this process, but a unique
// name means the rename can't collide even if a stray .tmp file
// is left behind by a previous crashed run.
async function writeManifestAtomic(workspaceRoot: string, manifest: ChatIndexManifest): Promise<void> {
  // `uniqueTmp` belt-and-suspenders: the in-process mutex above
  // already serializes callers, but a unique tmp name means the
  // rename can't collide even if a stray .tmp file is left behind
  // by a previous crashed run.
  await writeJsonAtomic(manifestPathFor(workspaceRoot), manifest, {
    uniqueTmp: true,
  });
}

// Read, mutate, and write the manifest under the in-process lock
// so concurrent callers cannot lose each other's updates.
export async function updateManifest(workspaceRoot: string, mutator: (m: ChatIndexManifest) => ChatIndexManifest): Promise<ChatIndexManifest> {
  return withManifestLock(async () => {
    const current = await readManifest(workspaceRoot);
    const next = mutator(current);
    await writeManifestAtomic(workspaceRoot, next);
    return next;
  });
}

// Drop a session's entry from both the per-session index file and
// the shared manifest. Used by the sessions hard-delete route so AI
// title / summary / keywords don't outlive the underlying jsonl on
// disk. Both removals tolerate "missing" — sessions that were never
// indexed have no entry to prune.
export async function removeSessionFromIndex(workspaceRoot: string, sessionId: string): Promise<void> {
  const safeId = safeSessionIdOrNull(sessionId);
  if (safeId === null) return;
  await rm(indexEntryPathFor(workspaceRoot, safeId), { force: true });
  await updateManifest(workspaceRoot, (manifest) => ({
    ...manifest,
    entries: manifest.entries.filter((entry) => entry.id !== safeId),
  }));
}

// --- freshness check ------------------------------------------------

// Shared parsing of `<indexDir>/<sessionId>.json` → `indexedAt` as
// milliseconds since epoch. Returns null on any failure (file
// missing, unreadable, JSON parse error, wrong shape, unparseable
// timestamp) so callers can each pick their own "no entry" semantic
// (skip vs reindex vs throttle) without duplicating the read.
// Exported so `isFresh` / `sessionJsonlChangedSinceIndex` share one
// canonical parse — CodeRabbit review on #1930.
export async function readIndexedAtMs(workspaceRoot: string, sessionId: string): Promise<number | null> {
  const safeId = safeSessionIdOrNull(sessionId);
  if (safeId === null) return null;
  try {
    const raw = await readFile(indexEntryPathFor(workspaceRoot, safeId), "utf-8");
    const entry: unknown = JSON.parse(raw);
    if (!isRecord(entry)) return null;
    const { indexedAt } = entry;
    if (typeof indexedAt !== "string") return null;
    const parsed = Date.parse(indexedAt);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

// A session is "fresh" when its per-session index file exists and
// was written less than `minIntervalMs` ago. Fresh sessions are
// skipped so a long conversation doesn't spam the CLI on every
// turn. Delegates disk / parse work to `readIndexedAtMs` so the
// two throttles stay in lockstep on entry-file semantics.
export async function isFresh(workspaceRoot: string, sessionId: string, now: number, minIntervalMs: number): Promise<boolean> {
  const indexedMs = await readIndexedAtMs(workspaceRoot, sessionId);
  if (indexedMs === null) return false;
  return now - indexedMs < minIntervalMs;
}

// Returns true when the session's jsonl was written / appended AFTER
// its last index entry — i.e. there IS new content to summarize.
//
// Complements `isFresh`: without this gate, the hourly scheduler
// tick re-summarizes every session even when nothing new was
// written since the last index (issue #1929). With it, the tick's
// per-session cost drops to O(stat + file read) for unchanged
// sessions and only spends a Claude CLI call on the ones that
// actually saw a new turn.
//
// Return-value contract, for each unknown state:
//  - Hostile / malformed sessionId → false (skip; something upstream
//    handed us a value that could escape the chat dir via `..`).
//  - Entry file missing/malformed → true (we've never captured this
//    session; index it).
//  - Jsonl file missing → false (nothing to reindex; the caller
//    would return null downstream anyway, but we short-circuit).
//  - Otherwise → jsonl mtime > entry.indexedAt.
export async function sessionJsonlChangedSinceIndex(workspaceRoot: string, sessionId: string): Promise<boolean> {
  const safeId = safeSessionIdOrNull(sessionId);
  if (safeId === null) return false;
  const indexedMs = await readIndexedAtMs(workspaceRoot, safeId);
  if (indexedMs === null) return true;
  try {
    const info = await stat(sessionJsonlPathFor(workspaceRoot, safeId));
    return info.mtimeMs > indexedMs;
  } catch {
    return false;
  }
}

// Path-traversal guard for session IDs used to derive on-disk paths.
// Two-step check so both a static analyser (CodeQL taints
// `sessionId` as a possible route-param input) AND a human reader
// can convince themselves the derived path stays inside the chat
// dir:
//
//   1. `path.basename()` collapses any `..` / separator to the last
//      segment. CodeQL recognises this as a barrier — a value whose
//      taint originates upstream is neutralised here.
//   2. `SAFE_SESSION_ID_RE` narrows the character class further
//      (word chars, `.`, `-`, up to 200 long) and rejects any
//      `..` substring, mirroring `server/api/bridge/sessionRole.ts`.
//
// Returns the cleaned id on success (identical to the input for
// legit ids) or `null` on any hostile / malformed input.
const SAFE_SESSION_ID_RE = /^[\w.-]{1,200}$/;
export function safeSessionIdOrNull(sessionId: string): string | null {
  const basename = path.basename(sessionId);
  if (basename !== sessionId) return null;
  if (!SAFE_SESSION_ID_RE.test(basename)) return null;
  if (basename.includes("..")) return null;
  return basename;
}

// --- session metadata ----------------------------------------------

interface SessionMeta {
  roleId?: string;
  startedAt?: string;
  origin?: string;
}

// Origins the chat-index summarizer intentionally skips (#1944). `system`
// sessions are hidden workers whose title never appears in any UI, and
// `scheduler` sessions fall back to their own `firstUserMessage` (the
// automation prompt) which identifies them well enough without an AI
// summary. Kept as a plain string set — `SESSION_ORIGINS` lives in
// src/types/session.ts and the indexer must not depend on the front-end
// types module.
const NON_INDEXED_ORIGINS: ReadonlySet<string> = new Set(["system", "scheduler"]);

async function readSessionMeta(workspaceRoot: string, sessionId: string): Promise<SessionMeta> {
  // Defence-in-depth: only `indexSession` calls this (with an
  // already-sanitized id), but a future caller wiring the helper
  // into a new code path shouldn't be able to escape the chat dir
  // by mistake.
  const safeId = safeSessionIdOrNull(sessionId);
  if (safeId === null) return {};
  try {
    const raw = await readFile(sessionMetaPathFor(workspaceRoot, safeId), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    return {
      roleId: typeof parsed.roleId === "string" ? parsed.roleId : undefined,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      origin: typeof parsed.origin === "string" ? parsed.origin : undefined,
    };
  } catch {
    return {};
  }
}

// List every session id that has a .jsonl file in the workspace
// chat dir. Used by the backfill helper. Filenames from disk are
// filtered through `safeSessionIdOrNull` so a stray file with a
// hostile name (`.` / `..` / a slash-containing name that survived
// readdir on some FS) can never flow through the backfill loop
// into `indexSession`.
export async function listSessionIds(workspaceRoot: string): Promise<string[]> {
  try {
    const files = await readdir(chatDirFor(workspaceRoot));
    const ids: string[] = [];
    for (const fileName of files) {
      if (!fileName.endsWith(".jsonl")) continue;
      const stem = fileName.slice(0, -".jsonl".length);
      const safeId = safeSessionIdOrNull(stem);
      if (safeId !== null) ids.push(safeId);
    }
    return ids;
  } catch {
    return [];
  }
}

// --- the core indexSession call ------------------------------------

// Index (or re-index) a single session. Returns the entry on
// success, or null if the session was skipped (fresh, empty,
// missing, or hostile id). The only exception that escapes is
// `ClaudeCliNotFoundError` — the caller uses it to disable the
// module for the rest of the process lifetime.
//
// `sessionId` is sanitized at entry (`safeSessionIdOrNull`) and the
// resulting `safeId` is threaded through every downstream file
// access, so `force: true` — a debug / rollout knob — cannot become
// a path-injection escape hatch (Codex review on #1930).
// Freshness / content-change / origin gates. All three are cheap-ish
// checks that short-circuit before the summarizer spawn. Extracted so
// `indexSession` stays under the cognitive-complexity ceiling.
async function shouldSkipBeforeSummarize(
  workspaceRoot: string,
  safeId: string,
  now: number,
  minInterval: number,
  force: boolean,
  meta: SessionMeta,
): Promise<boolean> {
  // Origin filter (#1944). Always applied, even under `force: true`:
  // `system` sessions never surface a title in any UI, and `scheduler`
  // sessions fall back to `firstUserMessage` (the automation prompt)
  // which identifies them without an AI summary.
  if (meta.origin !== undefined && NON_INDEXED_ORIGINS.has(meta.origin)) return true;
  if (force) return false;
  if (await isFresh(workspaceRoot, safeId, now, minInterval)) return true;
  // Second gate: even past the freshness window, if the jsonl has NOT
  // been written since the last index there's no new content to
  // summarize. Cuts idle scheduler tick cost from O(sessions) Claude
  // CLI calls to O(actual updates) — see #1929.
  return !(await sessionJsonlChangedSinceIndex(workspaceRoot, safeId));
}

export async function indexSession(workspaceRoot: string, sessionId: string, deps: IndexerDeps = {}): Promise<ChatIndexEntry | null> {
  const safeId = safeSessionIdOrNull(sessionId);
  if (safeId === null) return null;
  const summarize = deps.summarize ?? defaultSummarize;
  const now = (deps.now ?? Date.now)();
  const minInterval = deps.minIntervalMs ?? MIN_INDEX_INTERVAL_MS;
  const force = deps.force === true;
  const mode = deps.mode ?? "off";

  // Config-driven kill switch (#1944). "off" is the default so a fresh
  // workspace doesn't burn CLI budget until the user opts in from
  // Settings → Chat index. Bailing before any I/O keeps the check
  // ~free (~1 branch) so a backfill tick over N sessions costs O(N)
  // branches, not O(N × meta reads).
  if (mode === "off") return null;

  // Meta is read here (before jsonl load / summarizer spawn) so the
  // origin filter can short-circuit heavy work; the same object is
  // reused below when building the entry.
  const meta = await readSessionMeta(workspaceRoot, safeId);
  if (await shouldSkipBeforeSummarize(workspaceRoot, safeId, now, minInterval, force, meta)) return null;

  const input = await loadJsonlInput(sessionJsonlPathFor(workspaceRoot, safeId));
  if (!input.trim()) return null;

  const summary = await summarize(input, { model: mode });

  const entry: ChatIndexEntry = {
    id: safeId,
    roleId: meta.roleId ?? DEFAULT_ROLE_ID,
    startedAt: meta.startedAt ?? new Date(now).toISOString(),
    indexedAt: new Date(now).toISOString(),
    title: summary.title,
    summary: summary.summary,
    keywords: summary.keywords,
  };

  // Per-session file is written first so partial progress survives
  // a crash between the two writes: the next run can still observe
  // the fresh entry via isFresh and skip it.
  await writeJsonAtomic(indexEntryPathFor(workspaceRoot, safeId), entry);

  // Upsert into manifest under the in-process lock: replace any
  // prior entry with the same id, sort newest-first by startedAt.
  await updateManifest(workspaceRoot, (current) => {
    const filtered = current.entries.filter((entryItem) => entryItem.id !== safeId);
    filtered.push(entry);
    filtered.sort((leftEntry, rightEntry) => Date.parse(rightEntry.startedAt) - Date.parse(leftEntry.startedAt));
    return { version: 1, entries: filtered };
  });

  return entry;
}
