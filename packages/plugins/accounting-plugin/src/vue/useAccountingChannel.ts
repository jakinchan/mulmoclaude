// Subscribe to per-book accounting events.
//
// Returns a `version` ref that bumps every time the server publishes a
// change for the given bookId — addEntries, voidEntry,
// setOpeningBalances, upsertAccount, snapshot rebuild completion. View
// components watch `version` to drive `refetch` calls.
//
// `bookId` is reactive: switching the active book in BookSwitcher
// flips it; the composable unsubscribes from the old channel and
// subscribes to the new one.
//
// `onPayload` is an optional fine-grained hook for callers that want to
// inspect the event kind (e.g. show a "rebuilding…" indicator on
// `kind: "snapshots-rebuilding"`).
//
// The raw pub/sub transport is host-injected via `hostSubscribe`
// (see hostContext.ts) — the channel NAMES come from this package's
// own `./shared` so publisher and subscriber stay in lockstep.

import { ref, watch, onUnmounted, type Ref } from "vue";
import { bookChannel, booksChannel, BOOK_EVENT_KINDS, type BookChannelPayload } from "../shared";
import { hostProjectScope, hostSubscribe } from "./hostContext";

const BOOK_EVENT_KIND_VALUES = Object.values(BOOK_EVENT_KINDS);

/** The host hands subscribers an `unknown`, so rebuild the payload from
 *  the fields we can prove rather than trusting the publisher's type. */
function toBookChannelPayload(data: unknown): BookChannelPayload | null {
  if (typeof data !== "object" || data === null || !("kind" in data)) return null;
  const kind = BOOK_EVENT_KIND_VALUES.find((candidate) => candidate === data.kind);
  if (kind === undefined) return null;
  const period = "period" in data && typeof data.period === "string" ? data.period : undefined;
  return period === undefined ? { kind } : { kind, period };
}

export interface UseAccountingChannelReturn {
  /** Bumps on every per-book event for the current bookId. Resets to
   *  0 when bookId changes. */
  version: Ref<number>;
}

/** `scope` pins the subscription to one project for the life of the
 *  caller — pass the scope the surface was opened for. Omit it and the
 *  channel follows whatever project the host currently considers
 *  active, which is right for a surface the host itself scopes and
 *  always `null` on a single-root host. */
export function useAccountingChannel(
  bookId: Ref<string | null>,
  onPayload?: (payload: BookChannelPayload) => void,
  scope?: string | null,
): UseAccountingChannelReturn {
  const channelScope = scope === undefined ? hostProjectScope() : scope;
  const version = ref(0);
  let unsubscribe: (() => void) | null = null;

  function bind(nextBookId: string | null): void {
    unsubscribe?.();
    unsubscribe = null;
    version.value = 0;
    if (!nextBookId) return;
    // Scoped by the host's opaque project id (null for a single-root
    // host, which keeps the name `accounting:<bookId>`): a bookId is
    // unique within a root, so without it a write in one project would
    // refresh an open view of the same-named book in another.
    unsubscribe = hostSubscribe(bookChannel(nextBookId, channelScope), (data) => {
      version.value += 1;
      const event = toBookChannelPayload(data);
      if (event) onPayload?.(event);
    });
  }

  watch(bookId, bind, { immediate: true });
  onUnmounted(() => {
    unsubscribe?.();
    unsubscribe = null;
  });
  return { version };
}

/** Subscribe to "the list of books changed" events. Use in
 *  BookSwitcher.vue to refetch the dropdown contents when a sibling
 *  tab adds / deletes a book. */
export function useAccountingBooksChannel(onChange: () => void, scope?: string | null): void {
  const unsubscribe = hostSubscribe(booksChannel(scope === undefined ? hostProjectScope() : scope), onChange);
  onUnmounted(() => unsubscribe());
}
