// Execution log — append-only JSONL. One file per day, rotated
// automatically. Query function reads recent entries.
//
// I/O is injected via deps so tests can use in-memory storage.

import type { TaskLogEntry } from "./types.js";
import { toUtcIsoDate } from "./date.js";

const DEFAULT_QUERY_LIMIT = 50;

/** What the log layer needs from the host environment. */
export interface LogDeps {
  appendFile: (path: string, content: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  exists: (path: string) => boolean;
  ensureDir: (path: string) => Promise<void>;
}

/** Build the log file path for a given date. */
export function logFilePathFor(logsDir: string, date: Date): string {
  return `${logsDir}/${toUtcIsoDate(date)}.jsonl`;
}

/** Append a log entry to today's JSONL file. */
export async function appendLogEntry(logsDir: string, entry: TaskLogEntry, deps: LogDeps): Promise<void> {
  await deps.ensureDir(logsDir);
  const filePath = logFilePathFor(logsDir, new Date(entry.startedAt));
  await deps.appendFile(filePath, JSON.stringify(entry) + "\n");
}

/** Read log entries, newest first, with optional filters. */
export async function queryLog(
  logsDir: string,
  opts: {
    since?: string | undefined; // ISO — only entries after this time
    taskId?: string | undefined;
    limit?: number | undefined;
    /** Override "today" for testing. Defaults to `new Date()`. */
    date?: Date | undefined;
  },
  deps: LogDeps,
): Promise<TaskLogEntry[]> {
  const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
  const sinceMs = opts.since ? new Date(opts.since).getTime() : 0;

  // Read the target day's log (single-day query for now).
  const filePath = logFilePathFor(logsDir, opts.date ?? new Date());
  if (!deps.exists(filePath)) return [];

  const raw = await readLogFile(filePath, deps);
  const entries: TaskLogEntry[] = [];
  for (const line of raw.split("\n").filter(Boolean).reverse()) {
    if (entries.length >= limit) break;
    const entry = parseLogLine(line);
    if (entry && matchesFilters(entry, sinceMs, opts.taskId)) entries.push(entry);
  }
  return entries;
}

/** An unreadable log reads as an empty one — the caller's contract is
 *  "recent entries", not "prove the file exists". */
async function readLogFile(filePath: string, deps: LogDeps): Promise<string> {
  try {
    return await deps.readFile(filePath);
  } catch {
    return "";
  }
}

function parseLogLine(line: string): TaskLogEntry | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function matchesFilters(entry: TaskLogEntry, sinceMs: number, taskId: string | undefined): boolean {
  if (sinceMs > 0 && new Date(entry.startedAt).getTime() < sinceMs) return false;
  if (taskId && entry.taskId !== taskId) return false;
  return true;
}
