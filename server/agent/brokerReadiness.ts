// Where the MCP broker's startup beacon lands (#2842).
//
// The broker runs as a grandchild of this process — Claude CLI spawns it and
// owns its stderr — so nothing it writes reaches our logs. It POSTs one beacon
// when it answers `initialize`, and this module remembers it for the session.
//
// What that buys: when a turn dies on `handlePermission not found`, the
// recovery log can say whether the broker EVER answered. A broker that is
// merely slow and one that never came up produce identical symptoms otherwise,
// which is exactly the ambiguity #2842 was filed against.

import { resolveBrokerKind } from "./config.js";
import { ONE_SECOND_MS } from "../utils/time.js";

/** How slow a cold boot has to be before it is worth a warn rather than an
 *  info. The bundled broker answers in well under a second; the `tsx` path was
 *  measured at 20-24 s (#2233). Anything past this is already a large fraction
 *  of the CLI's connect wait, so the turn is one bad mount away from failing. */
export const BROKER_SLOW_BOOT_MS = 5 * ONE_SECOND_MS;

/** Sessions to remember. Only the most recent matter — the beacon is read when
 *  a turn fails, which is always the turn just now — and the map would
 *  otherwise grow for the life of the process. */
const MAX_TRACKED_SESSIONS = 200;

export interface BrokerReady {
  /** Milliseconds from the broker process starting to its module finishing
   *  evaluation: the cold boot itself (transcode / bundle read). */
  bootMs: number;
  /** Milliseconds from process start to answering `initialize` — what the
   *  CLI's connect-wait ceiling is actually racing. */
  initializeMs: number;
  /** Which spawn path the broker was launched on, as the broker itself sees it. */
  kind: "bundle" | "tsx";
}

const readyBySession = new Map<string, BrokerReady>();

export function recordBrokerReady(sessionId: string, ready: BrokerReady): void {
  readyBySession.delete(sessionId);
  readyBySession.set(sessionId, ready);
  // Insertion order is oldest-first, so the first key is the one to drop.
  const oldest = readyBySession.keys().next();
  if (readyBySession.size > MAX_TRACKED_SESSIONS && !oldest.done) {
    readyBySession.delete(oldest.value);
  }
}

/** Drop the session's reading, called at every spawn.
 *
 *  Load-bearing, not tidiness. The key is the CHAT session id, which is stable
 *  for the life of a conversation, while each turn spawns its own broker. Left
 *  alone, turn 1's successful beacon would still be sitting there when turn 5's
 *  broker fails to start, and the diagnostic would report `brokerEverReady:
 *  true` for a broker that never ran — the exact wrong answer, in the exact
 *  case the field exists to answer.
 *
 *  Residual window, knowingly left: a previous broker that answers `initialize`
 *  only AFTER its CLI gave up could land its beacon under the next spawn. The
 *  CLI kills its MCP children on exit and the beacon times out after 2 s, so
 *  this needs a >3 s straggler; it would overstate readiness on a diagnostic
 *  line, which is not worth a per-spawn token to close. */
export function clearBrokerReady(sessionId: string): void {
  readyBySession.delete(sessionId);
}

/** `null` means no beacon arrived for the CURRENT spawn — either the broker
 *  never got far enough to send one, or it is still booting. */
export function getBrokerReady(sessionId: string): BrokerReady | null {
  return readyBySession.get(sessionId) ?? null;
}

/** Everything a broker spawn owes the readiness state: forget the previous
 *  broker's beacon, and report which path this one takes for the spawn log.
 *
 *  One function rather than two calls at the call site, because they are the
 *  same event — a new broker is starting for this session — and two statements
 *  is how the reset gets dropped. It also means the `broker` field cannot
 *  appear in a log line unless the reset ran to produce it. */
export function beginBrokerSpawn(sessionId: string, options: { hasMcp: boolean; useDocker: boolean }): BrokerReady["kind"] | "none" {
  clearBrokerReady(sessionId);
  return options.hasMcp ? resolveBrokerKind(options.useDocker) : "none";
}

/** Test seam — the map is module state shared across cases. */
export function _resetBrokerReadiness(): void {
  readyBySession.clear();
}
