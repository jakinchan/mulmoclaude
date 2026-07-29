// Where `yarn dev`'s Vite proxy should send `/api` — the same port the backend
// binds (#2650).
//
// The backend honours `PORT`; Vite's proxy targets were literal `localhost:3001`.
// So `PORT=3100 yarn dev` moved only the server, and with a first instance still
// on 3001 the second browser silently rendered the FIRST instance's data — the
// proxy connects, it just connects to the wrong server.
//
// Every rule this needs is BORROWED, never re-implemented, because a second
// opinion about `PORT` is the same bug one level down:
//   - the numeric coercion and range come from `server/utils/envCoerce.ts`, the
//     module `server/system/env.ts` itself uses (so `0x1f`, `1e3`, `+3100`,
//     `3100.0` resolve here exactly as the backend resolves them);
//   - the `.env` VALUES are supplied by the caller, parsed with the launcher's
//     `parseEnvFile` — i.e. `dotenv.parse`, what the server's loader uses.
//
// This file only orders those sources and rejects the one value the backend
// accepts but a proxy cannot follow.
import { asInt, DEFAULT_PORT, PORT_RANGE } from "../../server/utils/envCoerce.js";

export const DEFAULT_SERVER_PORT = DEFAULT_PORT;

// Outside the backend's own range, so "the backend would ignore this" is
// distinguishable from "the backend would use this".
const NOT_A_PORT = -1;

/** Why a value could not be used, for a message that names the cause. */
export type PortRejection = "ignored-by-server" | "ephemeral";

export interface ParsedPort {
  port: number | null;
  reason?: PortRejection;
}

/**
 * The port the backend would bind for `raw`, or `null` with the reason it cannot
 * be a proxy target.
 *
 * `0` is the interesting case: the backend accepts it (`PORT_RANGE.min` is 0) and
 * asks the OS for an ephemeral port. Nothing evaluated at Vite-config time can
 * know which one, so this is a named refusal rather than a silent fallback.
 */
export const parseServerPort = (raw: string | undefined | null): ParsedPort => {
  const coerced = asInt(raw ?? undefined, NOT_A_PORT, PORT_RANGE);
  if (coerced === NOT_A_PORT) return { port: null, reason: "ignored-by-server" };
  if (coerced === 0) return { port: null, reason: "ephemeral" };
  return { port: coerced };
};

export interface ServerPortSources {
  processEnv?: Record<string, string | undefined>;
  /** `.env` as the launcher's `parseEnvFile` parsed it — NOT raw file text. */
  envFileValues?: Record<string, string | undefined> | null;
  /** Reported when a value was present but unusable, so a typo is not silently ignored. */
  onInvalid?: (detail: { source: string; raw: string; reason: PortRejection }) => void;
}

/**
 * The port the backend will bind: the environment first, then `.env`, then the
 * default — the order `server/system/loadEnv.ts` produces, where `.env` populates
 * `process.env` and an exported shell variable wins over the file.
 */
export const resolveServerPort = (sources: ServerPortSources = {}): number => {
  const candidates = [
    { source: "PORT", raw: sources.processEnv?.PORT },
    { source: ".env PORT", raw: sources.envFileValues?.PORT },
  ];
  for (const { source, raw } of candidates) {
    const { port, reason } = parseServerPort(raw);
    if (port !== null) return port;
    if (raw?.trim() && reason) sources.onInvalid?.({ source, raw, reason });
  }
  return DEFAULT_SERVER_PORT;
};

/** Human-readable cause, so the dev console says what to do about it. */
export const describeRejection = (reason: PortRejection): string =>
  reason === "ephemeral"
    ? "0 asks the OS for an ephemeral port, which the dev proxy cannot know — the client would talk to the wrong server"
    : "not a port the server would accept";

/** The proxy targets, built from one port so the five entries cannot drift apart. */
export const serverOrigins = (port: number): { http: string; ws: string } => ({
  http: `http://localhost:${port}`,
  ws: `ws://localhost:${port}`,
});
