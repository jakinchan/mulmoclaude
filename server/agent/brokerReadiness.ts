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

interface SessionReadiness {
  /** The broker the host is currently waiting on. A beacon carrying anything
   *  else belongs to an attempt that has already been replaced. */
  spawnId: string;
  ready: BrokerReady | null;
}

const readinessBySession = new Map<string, SessionReadiness>();

/** Record a beacon, unless it belongs to a superseded broker.
 *
 *  Returns whether it was accepted, so the caller can log the discard rather
 *  than swallow it. Attribution by chat session alone is not enough: the key is
 *  stable for the whole conversation, and the failure this feature diagnoses is
 *  "the broker was too slow" — so a straggler from the failed attempt arriving
 *  after the 3 s retry has already respawned is not a remote possibility, it is
 *  correlated with the very case that matters (Codex review on #2898). */
export function recordBrokerReady(sessionId: string, spawnId: string, ready: BrokerReady): boolean {
  const current = readinessBySession.get(sessionId);
  if (current === undefined || current.spawnId !== spawnId) return false;
  current.ready = ready;
  return true;
}

/** `null` means no beacon arrived for the CURRENT spawn — either the broker
 *  never got far enough to send one, or it is still booting. */
export function getBrokerReady(sessionId: string): BrokerReady | null {
  return readinessBySession.get(sessionId)?.ready ?? null;
}

/** Everything a broker spawn owes the readiness state: make this broker the one
 *  the host is waiting on (dropping any earlier reading), and hand back the
 *  spawn log's `broker` value.
 *
 *  One function rather than two statements at the call site, because they are
 *  the same event — a new broker is starting for this session — and two
 *  statements is how the reset gets dropped by a later edit. It also means the
 *  `broker` field cannot appear in a log line unless the reset ran to produce
 *  it.
 *
 *  `kind` is the turn's ALREADY-RESOLVED broker (null when the turn runs
 *  without MCP), never re-probed here: re-probing is what let the log and the
 *  spawned command disagree. */
export function beginBrokerSpawn(sessionId: string, spawnId: string, kind: BrokerReady["kind"] | null): BrokerReady["kind"] | "none" {
  readinessBySession.delete(sessionId);
  readinessBySession.set(sessionId, { spawnId, ready: null });
  // Insertion order is oldest-first, so the first key is the one to drop.
  const oldest = readinessBySession.keys().next();
  if (readinessBySession.size > MAX_TRACKED_SESSIONS && !oldest.done) {
    readinessBySession.delete(oldest.value);
  }
  return kind ?? "none";
}

/** Test seam — the map is module state shared across cases. */
export function _resetBrokerReadiness(): void {
  readinessBySession.clear();
}
