// Pub/sub publisher for the accounting plugin. Mirror of
// `server/events/file-change.ts`: module singleton + init function +
// fire-and-forget publish helpers. The init wiring lives in
// `server/index.ts` next to `initFileChangePublisher`.
//
// Channel names + payload shapes are imported from
// `src/config/pubsubChannels.ts` so the publisher cannot drift from
// the View-side subscribers.

import {
  bookChannel as accountingBookChannel,
  booksChannel as accountingBooksChannel,
  type BookChannelPayload as AccountingBookChannelPayload,
} from "../shared";
import { channelScopeFor, log, type IPubSub } from "./context.js";
import { errorMessage } from "../shared";

let pubsub: IPubSub | null = null;

export function initAccountingEventPublisher(instance: IPubSub): void {
  pubsub = instance;
}

/** `channelFor` is called INSIDE the guard, not before it: resolving the
 *  scope can throw (a write that reached the publisher with no root
 *  under explicit-root mode), and a lost event with a warning beats
 *  either crashing the write or publishing to the unscoped channel that
 *  every project can hear. */
function safePublish(channelFor: () => string, payload: unknown): void {
  if (!pubsub) return;
  let channel = "(unresolved)";
  try {
    channel = channelFor();
    pubsub.publish(channel, payload);
  } catch (err) {
    // Same fire-and-forget rationale as the file-change publisher:
    // dropping one event is better than crashing the server.
    log.warn("accounting", "publish failed; subscribers will miss this event", {
      channel,
      error: errorMessage(err),
    });
  }
}

/** Per-book change notification. `period` should be the entry's
 *  YYYY-MM bucket (or the earliest invalidated month for snapshot
 *  events).
 *
 *  `workspaceRoot` is the root the write happened under; the channel
 *  name is namespaced by the host's opaque scope for it (see
 *  `channelScopeFor`). Omit it — as a single-root host's service calls
 *  do — and the name is what it has always been. */
export function publishBookChange(bookId: string, payload: AccountingBookChannelPayload, workspaceRoot?: string): void {
  safePublish(() => accountingBookChannel(bookId, channelScopeFor(workspaceRoot)), payload);
}

/** Fired when the *list* of books changes (createBook, deleteBook).
 *  Payload is intentionally empty — subscribers refetch from
 *  /api/accounting. Scoped by root like `publishBookChange`. */
export function publishBooksChanged(workspaceRoot?: string): void {
  safePublish(() => accountingBooksChannel(channelScopeFor(workspaceRoot)), {});
}

/** Test-only — drop the module singleton so each test starts clean. */
export function _resetAccountingEventPublisherForTesting(): void {
  pubsub = null;
}
