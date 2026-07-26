// listCollections command handler (remote-host phase 1b).
//
// Runs in-process on the host, so it bypasses the HTTP view-token layer and
// calls the collection engine directly, returning the same shape as
// GET /api/collections: { collections: CollectionSummary[] }.
//
// Feeds (`source: "feed"`) are excluded: `discoverCollections` merges the
// feeds registry as a third root (so the desktop can show them together), but
// the mobile remote serves feeds through the dedicated listFeeds / getFeed
// handlers, so surfacing them here too would double-list them.
//
// Exposed as a factory (createListCollections) so the mapping is unit-testable
// with discovery stubbed; the default export wires the real engine functions.
import { discoverCollections, toSummary } from "../../workspace/collections/index.js";
import { toJsonObject } from "../commandChannel.js";
import type { CommandHandler, JsonObject } from "../commandChannel.js";

export interface ListCollectionsDeps {
  discover: typeof discoverCollections;
  toSummary: typeof toSummary;
}

export const createListCollections =
  (deps: ListCollectionsDeps): CommandHandler =>
  // Handlers receive the command's params; listCollections takes none (the
  // `__` prefix marks it intentionally unused per the lint config).
  async (__params: JsonObject) => {
    const collections = (await deps.discover()).filter((collection) => collection.source !== "feed").map(deps.toSummary);
    return toJsonObject({ collections });
  };

export const listCollections = createListCollections({ discover: discoverCollections, toSummary });
