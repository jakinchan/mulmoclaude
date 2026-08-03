// Schema-declared actions on a collection: the collection-level header buttons,
// the open record's action buttons, and the `kind: "mutate"` mini-form. Owns the
// `runningActions` generation guard (see `runningActionsGuard.ts`) that keeps a
// slow detail response from clobbering a newer optimistic dispatch key.
//
// A thin reactive shell: the run logic lives in `collectionActionRunners.ts`
// (module-level functions over an explicit context), the guard's stale-drop rule
// in `runningActionsGuard.ts`. The two load-path call sites (`loadCollection` /
// `refreshItemsInPlace`) stay in the component and drive the guard through the
// re-exposed `clearRunningActions` + `beginRunningActionsReconcile`.

import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { CollectionAction, CollectionMutateAction, CollectionDetail, CollectionItem, CollectionRecordIssue } from "@mulmoclaude/core/collection";
import { createRunningActionsGuard } from "./runningActionsGuard";
import {
  isActionRunning as isActionRunningOf,
  runCollectionAction as runCollectionActionOf,
  runAction as runActionOf,
  submitMutateParams as submitMutateParamsOf,
  repairCollection as repairCollectionOf,
  visibleActionsOf,
  runningActionIdsOf,
  type CollectionActionContext,
  type CollectionActionState,
} from "./collectionActionRunners";
import type { CollectionUi } from "../uiContext";
import type { useCollectionI18n } from "../lang";

type Translate = ReturnType<typeof useCollectionI18n>["t"];

interface UseCollectionActionsParams {
  collection: Ref<CollectionDetail | null>;
  viewing: Ref<CollectionItem | null>;
  /** Server-detected record data problems, reported back to the LLM by the
   *  Repair button. Owned by the component's load path. */
  dataIssues: Readonly<Ref<CollectionRecordIssue[]>>;
  /** Table-level error banner, shared with the inline-edit / refresh paths;
   *  a failed collection action surfaces here. */
  inlineError: Ref<string | null>;
  cui: CollectionUi;
  /** The chat card's channel into the current session (embedded mode only). */
  props: { sendTextMessage?: ((text?: string) => void) | undefined };
  t: Translate;
}

export interface UseCollectionActions extends CollectionActionState {
  /** The in-flight agent-action run keys — passed to CollectionHeader (and the
   *  record panel) so they can render the matching buttons with a spinner. The
   *  same reactive Set the generation guard mutates. */
  runningActions: Ref<Set<string>>;
  collectionActions: ComputedRef<CollectionAction[]>;
  visibleActions: ComputedRef<CollectionAction[]>;
  viewingRunningActionIds: ComputedRef<string[]>;
  isActionRunning: (actionId: string, itemId?: string) => boolean;
  runCollectionAction: (action: CollectionAction) => Promise<void>;
  runAction: (action: CollectionAction) => Promise<void>;
  submitMutateParams: (params: Record<string, unknown>) => Promise<void>;
  repairCollection: () => void;
  /** Clear the running-action spinners on a collection switch (bumps the guard
   *  generation, so an in-flight reconcile is dropped). */
  clearRunningActions: () => void;
  /** Snapshot the guard generation before a detail fetch; the returned applier
   *  adopts the server's keys only if no local mutation raced the fetch. */
  beginRunningActionsReconcile: () => (serverKeys: string[] | undefined) => void;
}

export function useCollectionActions({ collection, viewing, dataIssues, inlineError, cui, props, t }: UseCollectionActionsParams): UseCollectionActions {
  const actionPending = ref(false);
  const actionError = ref<string | null>(null);
  const collectionActionPending = ref(false);
  const mutateModal = ref<{ action: CollectionMutateAction; itemId: string } | null>(null);
  const mutatePending = ref(false);
  const mutateError = ref<string | null>(null);
  const guard = createRunningActionsGuard();

  const ctx: CollectionActionContext = {
    collection,
    viewing,
    dataIssues,
    inlineError,
    actionPending,
    actionError,
    collectionActionPending,
    mutateModal,
    mutatePending,
    mutateError,
    guard,
    cui,
    props,
    t,
  };

  const collectionActions = computed<CollectionAction[]>(() => collection.value?.schema.collectionActions ?? []);
  const visibleActions = computed<CollectionAction[]>(() => visibleActionsOf(collection.value, viewing.value));
  const viewingRunningActionIds = computed<string[]>(() => runningActionIdsOf(collection.value, viewing.value, guard));

  return {
    runningActions: guard.runningActions,
    actionPending,
    actionError,
    collectionActionPending,
    mutateModal,
    mutatePending,
    mutateError,
    collectionActions,
    visibleActions,
    viewingRunningActionIds,
    isActionRunning: (actionId, itemId) => isActionRunningOf(guard, actionId, itemId),
    runCollectionAction: (action) => runCollectionActionOf(ctx, action),
    runAction: (action) => runActionOf(ctx, action),
    submitMutateParams: (params) => submitMutateParamsOf(ctx, params),
    repairCollection: () => repairCollectionOf(ctx),
    clearRunningActions: () => guard.mutate((next) => next.clear()),
    beginRunningActionsReconcile: () => guard.beginReconcile(),
  };
}
