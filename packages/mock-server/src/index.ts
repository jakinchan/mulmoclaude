#!/usr/bin/env node
// @mulmobridge/mock-server — mock MulmoClaude server for bridge testing.
//
// Usage:
//   npx @mulmobridge/mock-server [options]
//
// Options:
//   --port <n>        Listen port (default: 3001)
//   --token <s>       Bearer token (default: mock-test-token)
//   --slow <ms>       Add delay before replies (default: 0)
//   --error           Always return error acks
//   --reject-auth     Reject all connections (test error handling)
//   --verbose, -v     Full protocol trace logging
//   --log-file <path> Write verbose log to file (always verbose)

import { createMockServer, type MockServerOptions } from "./server.js";

function failUsage(message: string): never {
  console.error(`Error: ${message}`);
  printHelp();
  process.exit(1);
}

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    failUsage(`--port must be an integer between 1 and 65535, got "${raw}"`);
  }
  return n;
}

function parseSlowMs(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    failUsage(`--slow must be a non-negative number, got "${raw}"`);
  }
  return n;
}

const DEFAULT_OPTIONS: MockServerOptions = {
  port: 3001,
  token: "mock-test-token",
  slowMs: 0,
  alwaysError: false,
  rejectAuth: false,
  verbose: false,
};

interface FlagOutcome {
  patch: Partial<MockServerOptions>;
  /** How many following argv entries this flag swallowed as its value. */
  consumed: number;
}

const NO_PATCH: FlagOutcome = { patch: {}, consumed: 0 };

function parseValueFlag(flag: string, value: string): FlagOutcome | null {
  if (flag === "--port") return { patch: { port: parsePort(value) }, consumed: 1 };
  if (flag === "--token") return { patch: { token: value }, consumed: 1 };
  if (flag === "--slow") return { patch: { slowMs: parseSlowMs(value) }, consumed: 1 };
  if (flag === "--log-file") return { patch: { logFile: value }, consumed: 1 };
  return null;
}

function parseBareFlag(flag: string): FlagOutcome | null {
  if (flag === "--error") return { patch: { alwaysError: true }, consumed: 0 };
  if (flag === "--reject-auth") return { patch: { rejectAuth: true }, consumed: 0 };
  if (flag === "--verbose" || flag === "-v") return { patch: { verbose: true }, consumed: 0 };
  if (flag === "--help" || flag === "-h") {
    printHelp();
    process.exit(0);
  }
  return null;
}

// A value flag whose value is missing (or empty) is not treated as a
// value flag at all — it falls through to the unknown-option error,
// which is what `--port` with nothing after it did before.
function parseFlag(flag: string, next: string | undefined): FlagOutcome {
  const withValue = next ? parseValueFlag(flag, next) : null;
  if (withValue) return withValue;
  const bare = parseBareFlag(flag);
  if (bare) return bare;
  if (flag.startsWith("-")) failUsage(`unknown option: ${flag}`);
  return NO_PATCH;
}

interface ArgScan {
  opts: MockServerOptions;
  /** Entries already claimed as a preceding flag's value. */
  skip: number;
}

function parseArgs(argv: readonly string[]): MockServerOptions {
  const flags = argv.slice(2);
  return flags.reduce<ArgScan>(
    (scan, flag, index) => {
      if (scan.skip > 0) return { ...scan, skip: scan.skip - 1 };
      const { patch, consumed } = parseFlag(flag, flags[index + 1]);
      return { opts: { ...scan.opts, ...patch }, skip: consumed };
    },
    { opts: DEFAULT_OPTIONS, skip: 0 },
  ).opts;
}

function printHelp(): void {
  console.log(`
@mulmobridge/mock-server — mock MulmoClaude server for bridge testing

Usage:
  npx @mulmobridge/mock-server [options]

Options:
  --port <n>         Listen port (default: 3001)
  --token <s>        Bearer token (default: mock-test-token)
  --slow <ms>        Add delay before replies (default: 0)
  --error            Always return error acks
  --reject-auth      Reject all connections (test error handling)
  --verbose, -v      Full protocol trace logging
  --log-file <path>  Write verbose log to file
  --help, -h         Show this help

Examples:
  # Basic echo mode
  npx @mulmobridge/mock-server

  # Test with the CLI bridge
  MULMOCLAUDE_AUTH_TOKEN=mock-test-token npx @mulmobridge/cli

  # Slow responses (simulate agent thinking)
  npx @mulmobridge/mock-server --slow 2000

  # Test error handling
  npx @mulmobridge/mock-server --error

  # Debug mode with full protocol trace
  npx @mulmobridge/mock-server --verbose
`);
}

const opts = parseArgs(process.argv);
createMockServer(opts);
