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

/** How slow a cold boot has to be before it is worth a warn rather than an
 *  info. The bundled broker answers in well under a second; the `tsx` path was
 *  measured at 20-24 s (#2233). Anything past this is already a large fraction
 *  of the CLI's connect wait, so the turn is one bad mount away from failing. */
export const BROKER_SLOW_BOOT_MS = 5_000;

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

/** `null` means no beacon arrived for this session — either the broker never
 *  got far enough to send one, or it is still booting. */
export function getBrokerReady(sessionId: string): BrokerReady | null {
  return readyBySession.get(sessionId) ?? null;
}

/** Test seam — the map is module state shared across cases. */
export function _resetBrokerReadiness(): void {
  readyBySession.clear();
}
