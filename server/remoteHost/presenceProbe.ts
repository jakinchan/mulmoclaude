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
import { DEFAULT_HEARTBEAT_MS, PRESENCE_STALE_BEATS } from "@mulmoclaude/core/remote-host/server";

// The same slack the runner gives itself, derived from the same constants: a laptop
// waking up gets three beats to write again before anyone calls it dead. Being wrong
// here costs a reconnect cycle, so the threshold leans towards patience.
export const PRESENCE_STALE_MS = DEFAULT_HEARTBEAT_MS * PRESENCE_STALE_BEATS;

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
export const presenceIsFresh = (data: Record<string, unknown> | undefined, now: number): Liveness => {
  if (!data) return null;
  const updatedAt = asMillis(data.updatedAt);
  // A pending serverTimestamp() reads as null until the write is acknowledged;
  // that is a write in flight, not a stale one.
  if (updatedAt === null) return null;
  // `online: false` is the runner's own goodbye, written on teardown. A truthful
  // state, not a broken one — it is meant to be down.
  if (data.online === false) return null;
  return now - updatedAt < PRESENCE_STALE_MS;
};

export interface PresenceProbeDeps {
  firestore: () => Firestore;
  channel: Channel;
  now?: () => number;
}

/** Reads the host's own presence document from the server and reports whether it is fresh. */
export const createPresenceProbe = (deps: PresenceProbeDeps): (() => Promise<Liveness>) => {
  const now = deps.now ?? Date.now;
  return async () => {
    // From the server, never the cache: a cached copy of our own last write answers
    // "fresh" precisely when the connection that should have carried it is dead.
    const snapshot = await getDocFromServer(hostDoc(deps.firestore(), deps.channel));
    return presenceIsFresh(snapshot.data(), now());
  };
};
