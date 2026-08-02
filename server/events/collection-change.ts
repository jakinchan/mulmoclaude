// Pub/sub publisher for collection record changes. Mirror of
// `server/accounting/eventPublisher.ts`: a module singleton wired once at
// startup that bridges the collection-plugin's host-agnostic
// `publishCollectionChange` to MulmoClaude's WebSocket pub/sub.
//
// The package's write path (`io.ts#writeItem`/`deleteItem`) calls
// `publishCollectionChange({ slug, ids, op })` after a successful write/delete,
// but the package can't reach the host's pubsub directly — so the host installs
// a publisher via `setCollectionChangePublisher`. This catches EVERY writer
// (agent `manageCollection`, UI routes, feed refresh, host-driven `spawn`)
// because all of them funnel through `writeItem`/`deleteItem`.
//
// Channel name + payload shape come from `src/config/pubsubChannels.ts` so the
// publisher can't drift from the View-side subscribers.
//
// `setCollectionChangePublisher` is a *namespace* import + feature-detect, NOT a
// named import, on purpose: the published `mulmoclaude` launcher resolves
// `@mulmoclaude/core/collection` from the registry via a caret range, so a
// freshly-installed launcher can transiently resolve a version older than the
// one that added this export. A named `import { setCollectionChangePublisher }`
// would then fail at ESM link time and crash the whole server at boot. A
// namespace import binds whatever the module exports (missing names are just
// `undefined`), so we degrade gracefully: live updates stay off until the
// package catches up, but the launcher boots. Matches the feature's
// "optional everywhere" design (the View-side `subscribeChanges` is optional too).

// eslint-disable-next-line no-restricted-imports -- namespace import is the feature-detect described above; only `setCollectionChangePublisher` is accessed, never the restricted raw io readers
import * as collectionPlugin from "@mulmoclaude/core/collection/server";
import type { CollectionChangePayload } from "@mulmoclaude/core/collection/server";
import { collectionChannel, type CollectionChannelPayload } from "../../src/config/pubsubChannels.js";
import { log } from "../system/logger/index.js";
import { errorMessage } from "../utils/errors.js";
import type { IPubSub } from "./pub-sub/index.js";

type SetPublisher = (publish: ((payload: CollectionChangePayload) => void) | null) => void;

/** The package's publisher setter, or null when the installed package predates
 *  it (see the module header on why this is feature-detected, not imported). */
function resolveSetPublisher(): SetPublisher | null {
  // Typed from the workspace source, which always has the export; the runtime
  // check is what covers an older installed package (see the module header).
  const candidate = collectionPlugin.setCollectionChangePublisher;
  return typeof candidate === "function" ? candidate : null;
}

/** Wire the package's change publisher to `instance`. Call once at server
 *  startup, next to `initFileChangePublisher` / `initAccountingEventPublisher`. */
export function initCollectionChangePublisher(instance: IPubSub): void {
  const setPublisher = resolveSetPublisher();
  if (!setPublisher) {
    log.info("collections", "installed @mulmoclaude/core/collection predates live updates; change publisher disabled", {});
    return;
  }
  setPublisher((payload: CollectionChangePayload) => {
    const channelPayload: CollectionChannelPayload = { slug: payload.slug, ids: payload.ids, op: payload.op };
    try {
      instance.publish(collectionChannel(payload.slug), channelPayload);
    } catch (err) {
      // Fire-and-forget, same rationale as the file-change / accounting
      // publishers: dropping one event (a missed live refresh) is better than
      // crashing the write path that triggered it.
      log.warn("collections", "collection-change publish failed; subscribers will miss this event", {
        slug: payload.slug,
        error: errorMessage(err),
      });
    }
  });
}
