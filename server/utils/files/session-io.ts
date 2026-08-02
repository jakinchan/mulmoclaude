import { appendFile, rm } from "fs/promises";
import path from "node:path";
import { WORKSPACE_DIRS, workspacePath } from "../../workspace/paths.js";
import { readTextUnder, writeTextUnder, resolvePath, ensureWorkspaceDir } from "./workspace-io.js";
import { isRecord } from "../types.js";
import { isSessionOrigin, type SessionOrigin } from "../../../src/types/session.js";

const CHAT = WORKSPACE_DIRS.chat;
const root = (rootOverride?: string) => rootOverride ?? workspacePath;

export function ensureChatDir(): void {
  ensureWorkspaceDir(CHAT);
}

function metaRel(sessionId: string): string {
  return path.posix.join(CHAT, `${sessionId}.json`);
}

function jsonlRel(sessionId: string): string {
  return path.posix.join(CHAT, `${sessionId}.jsonl`);
}

export interface SessionMeta {
  roleId?: string | undefined;
  startedAt?: string | undefined;
  firstUserMessage?: string | undefined;
  claudeSessionId?: string | undefined;
  hasUnread?: boolean | undefined;
  isBookmarked?: boolean | undefined;
  origin?: SessionOrigin | undefined;
  /** Number of user turns (queries) sent to this session. Bumped once
   *  per user message so a one-shot session (1) can be told apart from
   *  a long-running conversation. */
  userQueryCount?: number | undefined;
  [key: string]: unknown;
}

export type ReadMetaResult = { kind: "missing" } | { kind: "ok"; meta: SessionMeta } | { kind: "corrupt"; raw: string };

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === "string";
const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === "boolean";

// Checks every field `SessionMeta` declares. The trailing index signature
// accepts anything, so the extra keys older builds may have written ride
// along untouched — nothing is dropped and nothing is left unverified.
function isSessionMeta(value: unknown): value is SessionMeta {
  return (
    isRecord(value) &&
    isOptionalString(value.roleId) &&
    isOptionalString(value.startedAt) &&
    isOptionalString(value.firstUserMessage) &&
    isOptionalString(value.claudeSessionId) &&
    isOptionalBoolean(value.hasUnread) &&
    isOptionalBoolean(value.isBookmarked) &&
    (value.origin === undefined || isSessionOrigin(value.origin)) &&
    (value.userQueryCount === undefined || typeof value.userQueryCount === "number")
  );
}

export async function readSessionMetaFull(sessionId: string, rootOverride?: string): Promise<ReadMetaResult> {
  const raw = await readTextUnder(root(rootOverride), metaRel(sessionId));
  if (raw === null) return { kind: "missing" };
  // A file whose fields don't match the declared types joins the existing
  // "corrupt" branch rather than getting a new one: the caller's contract is
  // already "warn, treat as existing, never clobber", which is exactly the
  // right handling for a meta file we can't trust.
  const parsed: unknown = tryParseJson(raw);
  return isSessionMeta(parsed) ? { kind: "ok", meta: parsed } : { kind: "corrupt", raw };
}

/** `undefined` on unparseable input — no JSON document parses to `undefined`,
 *  so it is unambiguous as a sentinel. */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Treats corrupt as null — callers that need to distinguish use readSessionMetaFull.
export async function readSessionMeta(sessionId: string, rootOverride?: string): Promise<SessionMeta | null> {
  const result = await readSessionMetaFull(sessionId, rootOverride);
  return result.kind === "ok" ? result.meta : null;
}

export async function writeSessionMeta(sessionId: string, meta: SessionMeta, rootOverride?: string): Promise<void> {
  await writeTextUnder(root(rootOverride), metaRel(sessionId), JSON.stringify(meta, null, 2));
}

export async function createSessionMeta(sessionId: string, roleId: string, firstUserMessage: string, rootOverride?: string, origin?: string): Promise<void> {
  const meta: Record<string, unknown> = {
    roleId,
    startedAt: new Date().toISOString(),
    firstUserMessage,
  };
  if (origin) meta.origin = origin;
  await writeSessionMeta(sessionId, meta, rootOverride);
}

export async function backfillOrigin(sessionId: string, origin: NonNullable<SessionMeta["origin"]>, rootOverride?: string): Promise<void> {
  const meta = await readSessionMeta(sessionId, rootOverride);
  if (!meta || meta.origin) return; // already set
  await writeSessionMeta(sessionId, { ...meta, origin }, rootOverride);
}

export async function backfillFirstUserMessage(sessionId: string, message: string, rootOverride?: string): Promise<void> {
  const meta = await readSessionMeta(sessionId, rootOverride);
  if (!meta || meta.firstUserMessage) return;
  await writeSessionMeta(sessionId, { ...meta, firstUserMessage: message }, rootOverride);
}

export async function setClaudeSessionId(sessionId: string, claudeSessionId: string, rootOverride?: string): Promise<void> {
  const meta = await readSessionMeta(sessionId, rootOverride);
  if (!meta) return;
  await writeSessionMeta(sessionId, { ...meta, claudeSessionId }, rootOverride);
}

export async function clearClaudeSessionId(sessionId: string, rootOverride?: string): Promise<void> {
  const meta = await readSessionMeta(sessionId, rootOverride);
  if (!meta) return;
  const { claudeSessionId: __removed, ...rest } = meta;
  await writeSessionMeta(sessionId, rest, rootOverride);
}

export async function updateHasUnread(sessionId: string, hasUnread: boolean, rootOverride?: string): Promise<void> {
  const meta = await readSessionMeta(sessionId, rootOverride);
  if (!meta) return;
  await writeSessionMeta(sessionId, { ...meta, hasUnread }, rootOverride);
}

export async function updateIsBookmarked(sessionId: string, isBookmarked: boolean, rootOverride?: string): Promise<void> {
  const meta = await readSessionMeta(sessionId, rootOverride);
  if (!meta) return;
  await writeSessionMeta(sessionId, { ...meta, isBookmarked }, rootOverride);
}

export async function incrementUserQueryCount(sessionId: string, rootOverride?: string): Promise<void> {
  const meta = await readSessionMeta(sessionId, rootOverride);
  if (!meta) return;
  const current = typeof meta.userQueryCount === "number" ? meta.userQueryCount : 0;
  await writeSessionMeta(sessionId, { ...meta, userQueryCount: current + 1 }, rootOverride);
}

// Hard-deletes the session's .jsonl event log and .json meta sidecar.
// Missing files are tolerated — callers may invoke this for sessions
// whose meta or jsonl was never written (e.g. a crash mid-create).
export async function deleteSessionFiles(sessionId: string, rootOverride?: string): Promise<void> {
  await rm(sessionJsonlAbsPath(sessionId, rootOverride), { force: true });
  await rm(sessionMetaAbsPath(sessionId, rootOverride), { force: true });
}

export function sessionJsonlAbsPath(sessionId: string, rootOverride?: string): string {
  return resolvePath(root(rootOverride), jsonlRel(sessionId));
}

// .json sidecar to the event-log jsonl. mtime bumps on every writeSessionMeta — used as a "session changed" signal.
export function sessionMetaAbsPath(sessionId: string, rootOverride?: string): string {
  return resolvePath(root(rootOverride), metaRel(sessionId));
}

export async function readSessionJsonl(sessionId: string, rootOverride?: string): Promise<string | null> {
  return readTextUnder(root(rootOverride), jsonlRel(sessionId));
}

// Always ends with `\n` to prevent JSONL parse failures from a missing terminator.
export async function appendSessionLine(sessionId: string, line: string, rootOverride?: string): Promise<void> {
  const normalized = line.endsWith("\n") ? line : `${line}\n`;
  await appendFile(resolvePath(root(rootOverride), jsonlRel(sessionId)), normalized);
}
