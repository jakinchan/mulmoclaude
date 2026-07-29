// Can the phone still see this host? Asked from the phone's own vantage point,
// rather than inferred from this side (#2633).
//
// The runner tracks whether its own presence writes are being acknowledged, which
// is the same question one step earlier. This reads the document back FROM THE
// SERVER and judges it by age — the exact test the remote applies. Both answers
// are useful: a read that throws means the connection is genuinely gone, and a
// read that returns a stale document means the beats are not landing.
//
// Ported from MulmoTerminal (server/backends/remoteHost/presenceProbe.ts), where
// it has run since receptron/mulmoterminal#1045.
import { getDocFromServer } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { hostDoc } from "@mulmoclaude/core/remote-host";
import type { Channel } from "@mulmoclaude/core/remote-host";
import { presenceStaleAfterMs } from "@mulmoclaude/core/remote-host/server";

import { ONE_SECOND_MS } from "../utils/time.js";

// The runner's own threshold, taken from the runner rather than recomputed: a
// laptop waking up gets three beats to write again before anyone calls it dead.
// Being wrong here costs a reconnect cycle, so it leans towards patience.
export const PRESENCE_STALE_MS = presenceStaleAfterMs();

// A read that never settles would leave the probe un-rearmed — a sensor dying
// quietly, which is the very failure this module exists to catch. Firestore takes
// no abort signal, so the deadline has to be a race.
const PROBE_TIMEOUT_MS = 30 * ONE_SECOND_MS;

/** `null` = cannot be judged, which is NOT a failure: the document may simply not
 *  exist yet (a runner that has never announced), and treating "no answer" as
 *  "dead" would spin a reconnect loop against a host that is merely new. */
export type Liveness = boolean | null;

const hasToMillis = (value: object): value is { toMillis: () => number } => "toMillis" in value && typeof Reflect.get(value, "toMillis") === "function";

const asMillis = (value: unknown): number | null => {
  if (typeof value === "number") return value;
  // Firestore hands back a Timestamp for serverTimestamp() fields.
  if (typeof value === "object" && value !== null && hasToMillis(value)) return value.toMillis();
  return null;
};

/** Judge a presence document that was read successfully. Exported for its own test:
 *  the freshness rule is the part worth pinning, and it needs no Firestore. */
export const presenceIsFresh = (data: Record<string, unknown> | undefined, now: number, staleAfterMs: number = PRESENCE_STALE_MS): Liveness => {
  if (!data) return null;
  const updatedAt = asMillis(data.updatedAt);
  // A pending serverTimestamp() reads as null until the write is acknowledged;
  // that is a write in flight, not a stale one.
  if (updatedAt === null) return null;
  // `online: false` is the runner's own goodbye, written on teardown. A truthful
  // state, not a broken one — it is meant to be down.
  if (data.online === false) return null;
  return now - updatedAt < staleAfterMs;
};

/** Reject once `timeoutMs` has passed, so a stalled read answers instead of hanging. */
export const withTimeout = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  const timer: { handle: ReturnType<typeof setTimeout> | null } = { handle: null };
  const deadline = new Promise<never>((_, reject) => {
    timer.handle = setTimeout(() => reject(new Error(`presence read did not answer within ${Math.round(timeoutMs / ONE_SECOND_MS)}s`)), timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer.handle) clearTimeout(timer.handle);
  }
};

export interface PresenceProbeDeps {
  firestore: () => Firestore;
  channel: Channel;
  /** The runner's own staleness threshold. Pass `presenceStaleAfterMs(options)` when
   *  the runner uses a custom `heartbeatMs`, so the two judgments cannot diverge. */
  staleAfterMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** Reads the host's own presence document from the server and reports whether it is fresh. */
export const createPresenceProbe = (deps: PresenceProbeDeps): (() => Promise<Liveness>) => {
  const now = deps.now ?? Date.now;
  return async () => {
    // From the server, never the cache: a cached copy of our own last write answers
    // "fresh" precisely when the connection that should have carried it is dead.
    const snapshot = await withTimeout(getDocFromServer(hostDoc(deps.firestore(), deps.channel)), deps.timeoutMs ?? PROBE_TIMEOUT_MS);
    return presenceIsFresh(snapshot.data(), now(), deps.staleAfterMs ?? PRESENCE_STALE_MS);
  };
};
