// mutateRemoteViewItem command handler (remote-host phase 4 —
// plans/done/feat-remote-writable-view.md).
//
// Applies one update/delete requested by a `target: "mobile"` custom view on
// the phone, authorized by that view's OWN declared surface
// (editableFields / allowDelete) and enforced HOST-side (createMutateRemoteView)
// — the sandboxed view is never trusted. The parent (mulmoserver) supplies the
// `viewId` it mounted; the sandboxed document cannot spoof a different view's
// policy. Shares the builder with the desktop preview's HTTP route so both
// transports apply identical policy.
//
// Factory (createMutateRemoteView-backed) keeps the mapping unit-testable with
// the engine stubbed; the default export wires the real functions.
import { normalizeMutate, readIdParam } from "@mulmoclaude/core/remote-view";
import { loadCollection } from "../../workspace/collections/index.js";
import { mutateRemoteView, mutateRemoteViewFailureMessage } from "../../workspace/collections/remoteView.js";
import { coerceJsonObject, toJsonObject } from "../commandChannel.js";
import type { CommandHandler, JsonObject } from "../commandChannel.js";

export interface MutateRemoteViewHandlerDeps {
  loadCollection: typeof loadCollection;
  mutateRemoteView: typeof mutateRemoteView;
}

export const createMutateRemoteViewHandler =
  (deps: MutateRemoteViewHandlerDeps): CommandHandler =>
  async (params: JsonObject) => {
    const slug = readIdParam(params.slug);
    const viewId = readIdParam(params.viewId);
    const request = normalizeMutate({ op: params.op, id: params.id, patch: params.patch });
    if (!request) throw new Error("invalid mutate request — expected { op: 'update'|'delete', id, patch? }");
    const collection = await deps.loadCollection(slug);
    if (!collection) throw new Error(`collection '${slug}' not found`);
    const result = await deps.mutateRemoteView(collection, viewId, request);
    if (result.kind !== "ok") throw new Error(mutateRemoteViewFailureMessage(result, slug));
    // The delete branch is all strings, so the compile-time widen suffices. The
    // update branch carries a `CollectionItem`, whose values are `unknown`, so
    // it has to earn its JSON at runtime instead.
    if (result.op === "delete") return toJsonObject({ op: "delete", id: result.id });
    return coerceJsonObject({ op: "update", item: result.item });
  };

export const mutateRemoteViewItem = createMutateRemoteViewHandler({ loadCollection, mutateRemoteView });
