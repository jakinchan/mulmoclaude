// Low-level file I/O for the notifier. Reads use node:fs directly;
// writes go through an injected atomic-JSON writer (the host owns the
// rename-based atomic write so it stays single-sourced with its other
// writers). Kept separate from `engine.ts` so the path can be
// overridden in tests without monkey-patching.

import { hasStringProp, isErrorWithCode, isRecord, isUnknownArray } from "@mulmoclaude/common";
import { promises as fsPromises } from "node:fs";
import {
  NOTIFIER_LIFECYCLES,
  NOTIFIER_SEVERITIES,
  type NotifierEntry,
  type NotifierFile,
  type NotifierHistoryEntry,
  type NotifierHistoryFile,
} from "./types.js";

/** Injected atomic JSON writer — the host's `writeJsonAtomic`. */
export type WriteJson = (filePath: string, data: unknown) => Promise<void>;

const TERMINAL_TYPES = ["cleared", "cancelled"] as const;

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return allowed.some((candidate) => candidate === value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

// Checks every field `NotifierEntry` declares — `pluginData` is `unknown`,
// so nothing is left unverified. A partial check would be an assertion
// wearing a predicate's clothes.
function isNotifierEntry(value: unknown): value is NotifierEntry {
  return (
    hasStringProp(value, "id") &&
    hasStringProp(value, "pluginPkg") &&
    hasStringProp(value, "title") &&
    hasStringProp(value, "createdAt") &&
    isOneOf(NOTIFIER_SEVERITIES, value.severity) &&
    (value.lifecycle === undefined || isOneOf(NOTIFIER_LIFECYCLES, value.lifecycle)) &&
    isOptionalString(value.body) &&
    isOptionalString(value.navigateTarget)
  );
}

function isNotifierHistoryEntry(value: unknown): value is NotifierHistoryEntry {
  return isNotifierEntry(value) && hasStringProp(value, "terminalAt") && isOneOf(TERMINAL_TYPES, value.terminalType);
}

// `isRecord` rejects `null` and arrays, so `{ entries: [] }` and
// `{ entries: null }` stay malformed instead of reading as "no entries" —
// downstream `engine.get` / `list*` mutations assume a plain object.
function isNotifierFile(value: unknown): value is NotifierFile {
  return isRecord(value) && isRecord(value.entries) && Object.values(value.entries).every(isNotifierEntry);
}

function isNotifierHistoryFile(value: unknown): value is NotifierHistoryFile {
  return isRecord(value) && isUnknownArray(value.entries) && value.entries.every(isNotifierHistoryEntry);
}

/** Parsed JSON, or `undefined` when the file doesn't exist yet (first
 *  ever call on a fresh workspace) — unambiguous as a sentinel because
 *  no JSON document parses to `undefined`. */
async function readJsonIfPresent(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, "utf-8"));
  } catch (err) {
    if (isErrorWithCode(err) && err.code === "ENOENT") return undefined;
    throw err;
  }
}

/** Read the active-entries file. Returns an empty store when the file
 *  doesn't exist yet. Any other read or parse failure throws — the
 *  caller has to decide whether to surface or recover, since silently
 *  treating "malformed file" as "no entries" would lose data. A rejected
 *  file is never rewritten, so it stays on disk intact for repair. */
export async function loadActive(filePath: string): Promise<NotifierFile> {
  const parsed = await readJsonIfPresent(filePath);
  if (parsed === undefined) return { entries: {} };
  if (!isNotifierFile(parsed)) throw new Error(`notifier: malformed active.json at ${filePath}`);
  return parsed;
}

/** Write the active-entries file via the injected atomic writer so a
 *  half-written file is never visible to readers. The caller serialises
 *  writes (engine.ts queues mutations) — this function makes no
 *  concurrency guarantees of its own. */
export async function saveActive(writeJson: WriteJson, filePath: string, state: NotifierFile): Promise<void> {
  await writeJson(filePath, state);
}

/** Read the history file. Empty array on first run. Same parse-error
 *  policy as `loadActive`. */
export async function loadHistory(filePath: string): Promise<NotifierHistoryFile> {
  const parsed = await readJsonIfPresent(filePath);
  if (parsed === undefined) return { entries: [] };
  if (!isNotifierHistoryFile(parsed)) throw new Error(`notifier: malformed history.json at ${filePath}`);
  return parsed;
}

export async function saveHistory(writeJson: WriteJson, filePath: string, state: NotifierHistoryFile): Promise<void> {
  await writeJson(filePath, state);
}
