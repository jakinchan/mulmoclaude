// Collapse triggers that describe the SAME event into one pass: a call
// made while a pass is running joins it instead of starting a second.
//
// Keyed, because "the same event" is per-subject. The catch-up after a
// tab returns refreshes the session list AND the displayed transcript;
// two triggers arriving together should share both, but a trigger that
// arrives while the user has moved to a different session must NOT join
// the pass fetching the previous one — `loadSession` reuses an already
// visited session without re-fetching, so that transcript would keep a
// stale view with nothing left to refresh it.
//
// Deliberately NO trailing re-run — that is the difference from
// `makeSingleFlight` (server/utils/singleFlight.ts). There, a trigger
// arriving mid-pass stands for state the pass never looked at, so it
// must run again. Here the callers are two detections of one event (a
// tab coming back: the socket reconnecting and `visibilitychange`), so
// the second one has nothing new to report and a re-run is pure waste.
//
// Reach for `createMutationQueue` instead when every task must actually
// run, in order.

export interface InFlightShare {
  /** Run `task` under `key`, or join the pass already running for it. */
  run: (key: string, task: () => Promise<void>) => Promise<void>;
  /** Whether a pass is running for `key` — lets a caller log the collapse. */
  isRunning: (key: string) => boolean;
}

export function createInFlightShare(): InFlightShare {
  const running = new Map<string, Promise<void>>();
  return {
    isRunning: (key) => running.has(key),
    run(key, task) {
      const existing = running.get(key);
      if (existing) return existing;
      // A task that throws SYNCHRONOUSLY becomes a rejected promise
      // rather than an exception out of `run` — joiners must always get
      // something to await. `try` around the call rather than
      // `Promise.resolve().then(task)` so the task still STARTS
      // synchronously; deferring it to a microtask would let a caller
      // observe `isRunning` before the work had begun.
      //
      // Dropping the entry in `finally` does double duty: a failed pass
      // can't wedge the key, and the map can't grow one entry per
      // session the user has ever visited.
      const started = ((): Promise<void> => {
        // eslint-disable-next-line sonarjs/no-try-promise -- the `try` guards the SYNCHRONOUS throw before `task()` ever returns a promise; awaiting or `.catch()` here would defer the start to a microtask, which `isRunning` must not observe.
        try {
          return task();
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
      const pass = started.finally(() => {
        running.delete(key);
      });
      running.set(key, pass);
      return pass;
    },
  };
}
