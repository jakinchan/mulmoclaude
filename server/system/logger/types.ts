export type LogLevel = "error" | "warn" | "info" | "debug";

export type LogFormat = "text" | "json";

// Numeric priorities for level filtering. Lower = more important.
export const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface LogRecord {
  time: string;
  level: LogLevel;
  prefix: string;
  message: string;
  // Which process emitted this. Absent for the main server; set by processes
  // that share its log file and would otherwise be indistinguishable from it
  // — the MCP broker respawns once per turn, so its lines read as server
  // restarts to anyone holding only the log (#2904).
  source?: string;
  data?: Record<string, unknown>;
}

export interface Sink {
  name: string;
  level: LogLevel;
  write: (record: LogRecord) => void;
  // Drains any pending async I/O. Tests call this; production can ignore.
  flush?: () => Promise<void>;
}

export type Formatter = (record: LogRecord) => string;
