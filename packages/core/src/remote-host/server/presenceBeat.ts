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
//
// Beats are COUNTED, not timed (#2845). Counting how much time passed answers a
// different question than the one being asked: three beats' worth of wall clock
// also elapses while the machine is asleep, while the event loop is blocked, and
// when NTP steps the clock — in every one of those the beat never ran, so nothing
// was ever attempted, let alone failed. Counting only the beats that RAN cannot
// confuse the two, and needs no clock at all.
import { monotonicNowMs } from "./monotonicClock.js";

// Beats that may RUN unacknowledged before the host stops claiming to be online.
// One missed beat is a blip; three means the phone has had nothing fresh to read
// for as long as it takes to notice.
export const PRESENCE_STALE_BEATS = 3;

export interface PresenceBeatDeps {
  /** Announce online/offline. Resolves when the backend has the write. */
  write: (online: boolean) => Promise<void>;
  /** `staleAfterBeats` beats have run with nothing acknowledged — the phone cannot see
   *  this host. `silentMs` is how long that took, for the report only. */
  onStale: (silentMs: number) => void;
  /** A write was refused (auth, rules, quota). Carries the reason, which used to be dropped. */
  onError: (message: string) => void;
  staleAfterBeats: number;
  now?: () => number;
}

export interface PresenceBeat {
  /** Write presence unconditionally — startup and the goodbye on teardown. */
  announce: (online: boolean) => void;
  /** One heartbeat: report staleness if the last ack is too old, otherwise announce. */
  beat: () => void;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The callbacks belong to the host, and a heartbeat must not be the thing that
// takes the process down: an observer that throws would otherwise surface as an
// uncaught exception from a timer, or as an unhandled rejection from the write
// chain. There is nowhere to report it — `onError` is the reporter — so the only
// honest move is to keep beating.
const notify = (report: () => void, onThrow?: (error: unknown) => void): void => {
  try {
    report();
  } catch (error) {
    // Without an `onThrow` there is nowhere left to report to — the reporter is
    // what just threw. A throwing observer is the host's bug; losing the command
    // channel over it would be ours.
    onThrow?.(error);
  }
};

export const createPresenceBeat = (deps: PresenceBeatDeps): PresenceBeat => {
  const now = deps.now ?? monotonicNowMs;
  // Starts at "just acknowledged" so a host is given a full window to land its
  // first beat rather than being declared stale before it has written anything.
  // `lastAckMs` is carried for the report; `beatsSinceAck` is what decides.
  const state = { lastAckMs: now(), beatsSinceAck: 0 };

  const announce = (online: boolean): void => {
    const fail = (error: unknown) => notify(() => deps.onError(errorText(error)));
    const ack = () =>
      notify(() => {
        state.lastAckMs = now();
        state.beatsSinceAck = 0;
      });
    // A write can also fail SYNCHRONOUSLY — Firestore validates the payload before
    // it returns a promise (that is how one bad field throws before anything is
    // sent) — and that throw would otherwise escape through the heartbeat timer.
    notify(() => {
      deps.write(online).then(ack, fail);
    }, fail);
  };

  const beat = (): void => {
    state.beatsSinceAck += 1;
    // Deliberately no write here: another mutation would only queue up behind the
    // ones already stuck, and the answer for this beat is already known.
    if (state.beatsSinceAck >= deps.staleAfterBeats) {
      notify(() => deps.onStale(now() - state.lastAckMs));
      return;
    }
    announce(true);
  };

  return { announce, beat };
};
