import path from "path";
import type { LogFormat, LogLevel } from "./types.js";
import { LEVEL_PRIORITY } from "./types.js";

export interface FileRotationConfig {
  kind: "daily";
  maxFiles: number;
}

/** `split` sends warn/error to stderr and the rest to stdout; `stderr` sends
 *  everything to stderr. A process whose stdout is a protocol channel — the MCP
 *  broker speaks JSON-RPC there — must pick `stderr`, or an ordinary `log.info`
 *  lands between (or inside) protocol messages. */
export type ConsoleStream = "split" | "stderr";

export interface ConsoleSinkConfig {
  enabled: boolean;
  level: LogLevel;
  format: LogFormat;
  stream: ConsoleStream;
}

export interface FileSinkConfig {
  enabled: boolean;
  level: LogLevel;
  format: LogFormat;
  dir: string;
  rotation: FileRotationConfig;
}

export interface TelemetrySinkConfig {
  enabled: boolean;
  level: LogLevel;
  format: LogFormat;
}

export interface LoggerConfig {
  // Stamped onto every record this logger emits. See `LogRecord.source`.
  source?: string;
  sinks: {
    console: ConsoleSinkConfig;
    file: FileSinkConfig;
    telemetry: TelemetrySinkConfig;
  };
}

const DEFAULT_FILE_DIR = path.join("server", "system", "logs");
const DEFAULT_MAX_FILES = 14;

export const DEFAULT_CONFIG: LoggerConfig = {
  sinks: {
    console: { enabled: true, level: "info", format: "text", stream: "split" },
    file: {
      enabled: true,
      level: "debug",
      format: "json",
      dir: DEFAULT_FILE_DIR,
      rotation: { kind: "daily", maxFiles: DEFAULT_MAX_FILES },
    },
    telemetry: { enabled: false, level: "error", format: "json" },
  },
};

// `in` walks the prototype chain, so `LOG_LEVEL=constructor` used to pass as a
// level. `LEVEL_PRIORITY["constructor"]` is then a FUNCTION, and every
// `priority <= function` comparison is false — the process ran with every log
// record silently discarded and nothing said so.
const isLogLevel = (value: string): value is LogLevel => Object.prototype.hasOwnProperty.call(LEVEL_PRIORITY, value);

function parseLevel(raw: string | undefined): LogLevel | undefined {
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  return isLogLevel(normalized) ? normalized : undefined;
}

function parseFormat(raw: string | undefined): LogFormat | undefined {
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  return normalized === "text" || normalized === "json" ? normalized : undefined;
}

function parseConsoleStream(raw: string | undefined): ConsoleStream | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase();
  return normalized === "split" || normalized === "stderr" ? normalized : undefined;
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return undefined;
}

/** A process label is one short printable run. C0 controls, DEL and C1 are
 *  excluded by code point rather than a regex, so the `no-control-regex` lint
 *  rule has nothing to trip on. */
function isLabelChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code > 0x1f && (code < 0x7f || code > 0x9f);
}

/** Longest label kept. A source names a process; anything longer is a mistake,
 *  and bounding it also bounds what a bad value can push into every line. */
const SOURCE_MAX = 32;

// Returns a spreadable fragment rather than `string | undefined` so the branch
// lives here instead of in `resolveConfig`, which is already at its complexity
// ceiling.
//
// The text formatter interpolates the label verbatim, so a newline inside it
// would end the line early and let the remainder pose as a second record —
// `mcp-broker\n2026-01-01T00:00:00Z ERROR [auth] forged` reads as two entries
// in the file (the JSON sink escapes it, so only text logs forge). Dropping
// every control character removes that, and dropping rather than rejecting the
// whole value keeps the attribution this field exists for: a mangled
// LOG_SOURCE must not make a broker's lines read as the parent server's.
//
// A whitespace-only value is a shell accident (`LOG_SOURCE=$UNSET`), not a
// process claiming to be called " " — it ends up unset, and the record stays
// untagged rather than gaining an empty bracket.
function sourceField(raw: string | undefined): { source?: string } {
  const label = [...(raw ?? "")].filter(isLabelChar).join("").trim().slice(0, SOURCE_MAX);
  return label ? { source: label } : {};
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

export type Env = Partial<Record<string, string>>;

export function resolveConfig(env: Env): LoggerConfig {
  const coarseLevel = parseLevel(env.LOG_LEVEL);
  const consoleLevel = parseLevel(env.LOG_CONSOLE_LEVEL) ?? coarseLevel;
  const fileLevel = parseLevel(env.LOG_FILE_LEVEL) ?? coarseLevel;

  return {
    ...sourceField(env.LOG_SOURCE),
    sinks: {
      console: {
        enabled: parseBool(env.LOG_CONSOLE_ENABLED) ?? DEFAULT_CONFIG.sinks.console.enabled,
        level: consoleLevel ?? DEFAULT_CONFIG.sinks.console.level,
        format: parseFormat(env.LOG_CONSOLE_FORMAT) ?? DEFAULT_CONFIG.sinks.console.format,
        stream: parseConsoleStream(env.LOG_CONSOLE_STREAM) ?? DEFAULT_CONFIG.sinks.console.stream,
      },
      file: {
        enabled: parseBool(env.LOG_FILE_ENABLED) ?? DEFAULT_CONFIG.sinks.file.enabled,
        level: fileLevel ?? DEFAULT_CONFIG.sinks.file.level,
        format: parseFormat(env.LOG_FILE_FORMAT) ?? DEFAULT_CONFIG.sinks.file.format,
        dir: env.LOG_FILE_DIR ?? DEFAULT_CONFIG.sinks.file.dir,
        rotation: {
          kind: "daily",
          maxFiles: parsePositiveInt(env.LOG_FILE_MAX_FILES) ?? DEFAULT_CONFIG.sinks.file.rotation.maxFiles,
        },
      },
      telemetry: {
        enabled: parseBool(env.LOG_TELEMETRY_ENABLED) ?? DEFAULT_CONFIG.sinks.telemetry.enabled,
        level: parseLevel(env.LOG_TELEMETRY_LEVEL) ?? DEFAULT_CONFIG.sinks.telemetry.level,
        format: parseFormat(env.LOG_TELEMETRY_FORMAT) ?? DEFAULT_CONFIG.sinks.telemetry.format,
      },
    },
  };
}
