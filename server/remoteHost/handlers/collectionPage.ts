// Shared pagination for the collection/feed record handlers.
//
// The command channel writes the result INSIDE the command document, and
// Firestore caps a document at 1 MiB. offset/limit slice the records; limit is
// clamped to [1, MAX_PAGE_LIMIT] (default 50) so a runaway page can't blow
// that budget. The clamps live in @mulmoclaude/core/remote-view (params arrive
// as untyped JSON there too) so the record handlers and the remote-view bridge
// serve identical page semantics — re-exported here for the handlers.
import { clampLimit, clampOffset, readIdParam } from "@mulmoclaude/core/remote-view";
import { deriveAll, type DerivableFieldSpec, type DerivableRecord } from "@mulmoclaude/core/collection";
import { isRecord } from "../../utils/types.js";
import type { JsonObject } from "../commandChannel.js";

export { clampLimit, clampOffset, readIdParam };

/** Resolve record-local computed fields (derived formulas) before paging, so
 *  channel consumers — the phase-2 card list and a remote view's `getItems` —
 *  see the same numbers the desktop renders. There is no ref cache over the
 *  channel, so formulas that dereference `ref` fields stay absent; the desktop
 *  phone-frame preview derives with the same empty cache (parity). */
export const deriveItems = (schema: { fields?: Record<string, DerivableFieldSpec> }, items: unknown[]): DerivableRecord[] =>
  items.map((item) => deriveAll({ fields: schema.fields ?? {} }, isRecord(item) ? item : {}, {}));

/** Build the paginated result.
 *
 *  `toJsonObject` cannot serve this one. `CollectionDetail` reaches
 *  `schema.spawn.set`, typed `Record<string, unknown>`, so the payload
 *  genuinely CANNOT be proven JSON by the type system — it is JSON at runtime
 *  because the schema loader only ever puts JSON there, a fact about the
 *  loader that these types do not record.
 *
 *  Removing this assertion means giving `spawn.set` a JSON-valued type at the
 *  schema layer, not adjusting anything here. */
export const pageResult = (detail: unknown, items: unknown[], offset: number, limit: number): JsonObject =>
  ({
    collection: detail,
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
  }) as JsonObject;
