import { readJournalState as readJournalStateRaw, writeJournalState as writeJournalStateRaw } from "../../utils/files/journal-io.js";
import { ONE_HOUR_MS, ONE_DAY_MS } from "../../utils/time.js";
import { log } from "../../system/logger/index.js";
import { isRecord } from "../../utils/types.js";

// Bump on backwards-incompatible schema changes — older state files
// are discarded and rebuilt (one extra archivist pass).
export const JOURNAL_STATE_VERSION = 1;

export interface ProcessedSessionRecord {
  // mtime at last ingest; advance triggers re-ingest of appended events.
  lastMtimeMs: number;
}

export interface JournalState {
  version: number;
  lastDailyRunAt: string | null;
  lastOptimizationRunAt: string | null;
  dailyIntervalHours: number;
  optimizationIntervalDays: number;
  processedSessions: Record<string, ProcessedSessionRecord>;
  knownTopics: string[];
}

export const DEFAULT_DAILY_INTERVAL_HOURS = 1;
export const DEFAULT_OPTIMIZATION_INTERVAL_DAYS = 7;

export function defaultState(): JournalState {
  return {
    version: JOURNAL_STATE_VERSION,
    lastDailyRunAt: null,
    lastOptimizationRunAt: null,
    dailyIntervalHours: DEFAULT_DAILY_INTERVAL_HOURS,
    optimizationIntervalDays: DEFAULT_OPTIMIZATION_INTERVAL_DAYS,
    processedSessions: {},
    knownTopics: [],
  };
}

// Forgiving toward partial / hand-edited input — fill defaults instead of throwing.
export function parseState(raw: unknown): JournalState {
  if (!isRecord(raw)) return defaultState();

  // Log the version-mismatch reset (#799 PR1) so postmortems can tell
  // it apart from a missing-file first run.
  if (raw.version !== JOURNAL_STATE_VERSION) {
    log.info("journal", "state schema version mismatch — resetting", {
      from: raw.version,
      to: JOURNAL_STATE_VERSION,
    });
    return defaultState();
  }

  const fallback = defaultState();
  return {
    version: JOURNAL_STATE_VERSION,
    lastDailyRunAt: typeof raw.lastDailyRunAt === "string" ? raw.lastDailyRunAt : null,
    lastOptimizationRunAt: typeof raw.lastOptimizationRunAt === "string" ? raw.lastOptimizationRunAt : null,
    dailyIntervalHours: typeof raw.dailyIntervalHours === "number" && raw.dailyIntervalHours > 0 ? raw.dailyIntervalHours : fallback.dailyIntervalHours,
    optimizationIntervalDays:
      typeof raw.optimizationIntervalDays === "number" && raw.optimizationIntervalDays > 0 ? raw.optimizationIntervalDays : fallback.optimizationIntervalDays,
    processedSessions: parseProcessedSessions(raw.processedSessions),
    knownTopics: Array.isArray(raw.knownTopics) ? raw.knownTopics.filter((topic): topic is string => typeof topic === "string") : [],
  };
}

function parseProcessedSessions(raw: unknown): Record<string, ProcessedSessionRecord> {
  if (!isRecord(raw)) return {};
  const out: Record<string, ProcessedSessionRecord> = {};
  for (const [sessionId, rec] of Object.entries(raw)) {
    if (!isRecord(rec)) continue;
    const mtime = rec.lastMtimeMs;
    if (typeof mtime === "number" && mtime >= 0) {
      out[sessionId] = { lastMtimeMs: mtime };
    }
  }
  return out;
}

export function isDailyDue(state: JournalState, nowMs: number): boolean {
  if (state.lastDailyRunAt === null) return true;
  const last = Date.parse(state.lastDailyRunAt);
  if (Number.isNaN(last)) return true;
  const intervalMs = state.dailyIntervalHours * ONE_HOUR_MS;
  return nowMs - last >= intervalMs;
}

export function isOptimizationDue(state: JournalState, nowMs: number): boolean {
  if (state.lastOptimizationRunAt === null) return true;
  const last = Date.parse(state.lastOptimizationRunAt);
  if (Number.isNaN(last)) return true;
  const intervalMs = state.optimizationIntervalDays * ONE_DAY_MS;
  return nowMs - last >= intervalMs;
}

export async function readState(workspaceRoot: string): Promise<JournalState> {
  const raw = await readJournalStateRaw<unknown>(null, workspaceRoot);
  return parseState(raw);
}

export async function writeState(workspaceRoot: string, state: JournalState): Promise<void> {
  await writeJournalStateRaw(state, workspaceRoot);
}
