// Debounced, serialised auto-save for the presentDocument source editor.
//
// Extracted from `View.vue` so the cancellation boundary can be tested without
// a DOM: the interesting behaviour is not "does it save" but "when does it
// decide NOT to". Two rules the view depends on:
//
//   * writes are chained, never parallel — two overlapping PUTs of the same
//     path can land out of order and leave disk holding the older buffer;
//   * `isWanted` is re-checked when a queued write RUNS, not only when it was
//     queued. Cancelling the debounce timer cannot stop a write already handed
//     to the chain (it is sitting behind an in-flight one), so a Cancel — or
//     unticking auto save — would otherwise still persist a discarded buffer.

export interface AutoSaverOptions<TTarget> {
  /** Quiet period after the last change before the write is queued. */
  delayMs: number;
  /** Whether the write is still wanted, for the target it was queued against. */
  isWanted: (target: TTarget) => boolean;
  /** Performs the write. A rejection is isolated — it fails that write only,
   *  and the queue carries on. Reporting it is this callback's job (the editor
   *  raises its own save-error banner and retries on the next keystroke). */
  write: (text: string, target: TTarget) => Promise<unknown>;
}

export interface AutoSaver<TTarget> {
  /** (Re)start the debounce for `text`, to be written to `target`. */
  schedule: (text: string, target: TTarget) => void;
  /** Drop a write still waiting out the debounce. Chained writes are not
   *  cancellable — `isWanted` is what stops those. */
  cancel: () => void;
  /** Resolves once nothing is outstanding — including a write still waiting out
   *  the debounce, which has not reached the chain yet. For teardown and tests.
   *  Never rejects; a failing write is the `write` callback's to report. */
  settled: () => Promise<unknown>;
}

export function createAutoSaver<TTarget>(options: AutoSaverOptions<TTarget>): AutoSaver<TTarget> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  // Resolves when the current debounce has either queued its write or been
  // dropped. Without it `settled()` would report "nothing outstanding" for a
  // write that is merely still waiting out `delayMs`.
  let debounced: Promise<void> = Promise.resolve();
  let endDebounce = (): void => {};

  // A rejected write must not poison the queue: once `chain` is rejected, every
  // later `.then(run)` is skipped and auto save is dead for the rest of the
  // session. Each write is isolated instead.
  function enqueue(text: string, target: TTarget): void {
    const run = async (): Promise<void> => {
      if (!options.isWanted(target)) return;
      try {
        await options.write(text, target);
      } catch {
        // Isolated on purpose — see `write` in AutoSaverOptions.
      }
    };
    chain = chain.then(run, run);
  }

  return {
    schedule(text, target) {
      // Replacing a pending debounce releases it: nothing will ever be queued
      // for that one, so a `settled()` waiting on it must not hang.
      endDebounce();
      clearTimeout(timer);
      debounced = new Promise<void>((resolve) => {
        endDebounce = resolve;
      });
      timer = setTimeout(() => {
        timer = undefined;
        enqueue(text, target);
        endDebounce();
      }, options.delayMs);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      endDebounce();
    },
    settled() {
      // `chain` is read after the debounce resolves — by then it includes the
      // write that debounce just queued.
      return debounced.then(() => chain);
    },
  };
}
