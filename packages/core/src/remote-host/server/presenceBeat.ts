// The presence heartbeat, and the one question the host could never answer about
// itself: are my beats still landing? (#2633)
//
// The phone decides whether a host is reachable from the freshness of the presence
// document. The host decided whether it was connected from listener errors — a
// different path entirely, so a presence write could fail on every beat while
// onSnapshot stayed quiet and the host kept reporting itself green.
//
// The sensor is the age of the last ACKNOWLEDGED write, not a count of failed ones.
// Firestore does not reject a write it cannot deliver; it queues it and leaves the
// promise pending ("if the client is offline, the returned Promise will not resolve
// for a potentially-long time" — @firebase/firestore typings). A rejection counter
// would therefore read zero throughout the outage it exists to catch.
//
// The write is injected so this file needs no Firestore: hostRunner binds it to
// setDoc, tests bind it to a promise they control.

// Beats a write may go unacknowledged before the host stops claiming to be online.
// One missed beat is a blip; three means the phone has had nothing fresh to read
// for as long as it takes to notice.
export const PRESENCE_STALE_BEATS = 3;

export interface PresenceBeatDeps {
  /** Announce online/offline. Resolves when the backend has the write. */
  write: (online: boolean) => Promise<void>;
  /** No write has been acknowledged for `silentMs` — the phone cannot see this host. */
  onStale: (silentMs: number) => void;
  /** A write was refused (auth, rules, quota). Carries the reason, which used to be dropped. */
  onError: (message: string) => void;
  staleAfterMs: number;
  now?: () => number;
}

export interface PresenceBeat {
  /** Write presence unconditionally — startup and the goodbye on teardown. */
  announce: (online: boolean) => void;
  /** One heartbeat: report staleness if the last ack is too old, otherwise announce. */
  beat: () => void;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createPresenceBeat = (deps: PresenceBeatDeps): PresenceBeat => {
  const now = deps.now ?? Date.now;
  // Starts at "just acknowledged" so a host is given a full window to land its
  // first beat rather than being declared stale before it has written anything.
  const state = { lastAckMs: now() };

  const announce = (online: boolean): void => {
    deps.write(online).then(
      () => {
        state.lastAckMs = now();
      },
      (error: unknown) => deps.onError(errorText(error)),
    );
  };

  const beat = (): void => {
    const silentMs = now() - state.lastAckMs;
    // Deliberately no write here: another mutation would only queue up behind the
    // ones already stuck, and the answer for this beat is already known.
    if (silentMs >= deps.staleAfterMs) {
      deps.onStale(silentMs);
      return;
    }
    announce(true);
  };

  return { announce, beat };
};
