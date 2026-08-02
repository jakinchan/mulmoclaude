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
  /** Performs the write. Rejections are the caller's business, not ours. */
  write: (text: string, target: TTarget) => Promise<unknown>;
}

export interface AutoSaver<TTarget> {
  /** (Re)start the debounce for `text`, to be written to `target`. */
  schedule: (text: string, target: TTarget) => void;
  /** Drop a write still waiting out the debounce. Chained writes are not
   *  cancellable — `isWanted` is what stops those. */
  cancel: () => void;
  /** Resolves once every queued write has settled. For teardown and tests. */
  settled: () => Promise<unknown>;
}

export function createAutoSaver<TTarget>(options: AutoSaverOptions<TTarget>): AutoSaver<TTarget> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  return {
    schedule(text, target) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        chain = chain.then(() => (options.isWanted(target) ? options.write(text, target) : undefined));
      }, options.delayMs);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
    settled() {
      return chain;
    },
  };
}
