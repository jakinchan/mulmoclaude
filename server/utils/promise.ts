/** Resolve when `promise` settles or when `timeoutMs` elapses, whichever comes
 *  first — for "wait for this, but answer regardless" paths where the caller has
 *  a usable degraded answer and a hard deadline to meet.
 *
 *  A rejection counts as settled: the caller asked to stop waiting, not to
 *  learn the outcome. The timer is unref'd so a pending wait cannot be what
 *  keeps the process alive. */
export function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    void promise
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}
