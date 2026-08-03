// The action-run logic behind `useCollectionActions`, as module-level functions
// over an explicit context object. Kept out of the composable's setup body so
// each stays a small, independently-readable unit (and the composable stays a
// thin reactive shell). Every write goes through the injected `cui`; the
// optimistic run keys go through the injected `guard`.

import type { Ref } from "vue";
import {
  actionVisible,
  agentActionRunKey,
  defangForPrompt,
  rowIdOf,
  type CollectionAction,
  type CollectionMutateAction,
  type CollectionDetail,
  type CollectionItem,
  type CollectionRecordIssue,
} from "@mulmoclaude/core/collection";
import type { RunningActionsGuard } from "./runningActionsGuard";
import type { CollectionUi } from "../uiContext";
import type { useCollectionI18n } from "../lang";

type Translate = ReturnType<typeof useCollectionI18n>["t"];

/** The action UI-state refs the composable owns and the runners mutate — shared
 *  between the run context (below) and the composable's public surface, so the
 *  field set is declared once. */
export interface CollectionActionState {
  actionPending: Ref<boolean>;
  actionError: Ref<string | null>;
  collectionActionPending: Ref<boolean>;
  mutateModal: Ref<{ action: CollectionMutateAction; itemId: string } | null>;
  mutatePending: Ref<boolean>;
  mutateError: Ref<string | null>;
}

export interface CollectionActionContext extends CollectionActionState {
  collection: Ref<CollectionDetail | null>;
  viewing: Ref<CollectionItem | null>;
  dataIssues: Readonly<Ref<CollectionRecordIssue[]>>;
  inlineError: Ref<string | null>;
  guard: RunningActionsGuard;
  cui: CollectionUi;
  props: { sendTextMessage?: ((text?: string) => void) | undefined };
  t: Translate;
}

/** Dispatch a seed prompt into the current session (embedded chat card) or a new
 *  chat in `role` (standalone page). */
function dispatchPrompt(ctx: CollectionActionContext, text: string, role: string): void {
  if (ctx.props.sendTextMessage) {
    ctx.props.sendTextMessage(text);
    return;
  }
  ctx.cui.startChat(text, role);
}

/** True when a `kind: "agent"` action's hidden worker is in flight. Keys mirror
 *  the server's dispatch guard via `agentActionRunKey`. */
export function isActionRunning(guard: RunningActionsGuard, actionId: string, itemId?: string): boolean {
  return guard.isRunning(agentActionRunKey(actionId, itemId));
}

/** Actions whose optional `when` predicate matches the open record. */
export function visibleActionsOf(collection: CollectionDetail | null, viewing: CollectionItem | null): CollectionAction[] {
  if (!viewing) return [];
  return (collection?.schema.actions ?? []).filter((action) => actionVisible(action, viewing));
}

/** Ids of the open record's actions whose hidden worker is running. */
export function runningActionIdsOf(collection: CollectionDetail | null, viewing: CollectionItem | null, guard: RunningActionsGuard): string[] {
  if (!collection || !viewing) return [];
  const itemId = rowIdOf(collection.schema.primaryKey, viewing);
  if (!itemId) return [];
  return (collection.schema.actions ?? []).filter((action) => isActionRunning(guard, action.id, itemId)).map((action) => action.id);
}

/** Run a collection-level action: the server assembles the seed prompt. `kind:
 *  "chat"` starts a new chat; `kind: "agent"` is dispatched server-side as a
 *  hidden worker — mark it running and let the completion ping's refetch
 *  reconcile. */
export async function runCollectionAction(ctx: CollectionActionContext, action: CollectionAction): Promise<void> {
  const current = ctx.collection.value;
  if (!current || ctx.collectionActionPending.value || isActionRunning(ctx.guard, action.id)) return;
  // Optimistic key BEFORE the POST: a fast worker's completion ping can beat the
  // POST's resolution, and adding the key afterwards would strand the spinner.
  const runKey = action.kind === "agent" ? agentActionRunKey(action.id) : null;
  if (runKey) ctx.guard.mutate((next) => next.add(runKey));
  ctx.collectionActionPending.value = true;
  ctx.inlineError.value = null;
  const result = await ctx.cui.runCollectionAction(current.slug, action.id);
  ctx.collectionActionPending.value = false;
  if (!result.ok) {
    // 409 = the server's dispatch guard CONFIRMED a worker in flight — keep the
    // key so the button stays disabled; drop it only for real launch failures.
    if (runKey && result.status !== 409) ctx.guard.mutate((next) => next.delete(runKey));
    ctx.inlineError.value = result.error;
    return;
  }
  if (result.data.dispatched) return; // key already set; the completion ping's refetch reconciles
  if (result.data.written) return; // mutate never reaches this branch; narrows the union
  dispatchPrompt(ctx, result.data.prompt, result.data.role);
}

/** Report the server-detected record data problems back to the LLM so it fixes
 *  the offending files. Dispatches into the current chat when embedded, else a
 *  new General chat. */
export function repairCollection(ctx: CollectionActionContext): void {
  const current = ctx.collection.value;
  if (!current || ctx.dataIssues.value.length === 0) return;
  // Issue text carries record-controlled values, so defang structural injection
  // vectors (shared with the server's presentCollection path via `defangForPrompt`).
  const lines = ctx.dataIssues.value.map((issue) => `- ${defangForPrompt(issue.file)}: ${defangForPrompt(issue.problem)}`).join("\n");
  const prompt = ctx.t("collectionsView.repairPrompt", { title: current.title, count: ctx.dataIssues.value.length, issues: lines });
  dispatchPrompt(ctx, prompt, ctx.cui.generalRoleId);
}

/** POST one mutate action and, on success, adopt the written record for the open
 *  panel. Errors land in the modal when one is open, else on the panel. */
async function executeMutate(ctx: CollectionActionContext, action: CollectionMutateAction, itemId: string, params: Record<string, unknown>): Promise<boolean> {
  // Snapshot before the await (route changes can null `collection`); the
  // re-entrancy guard keeps one write in flight at a time.
  const current = ctx.collection.value;
  if (!current || ctx.mutatePending.value) return false;
  ctx.mutatePending.value = true;
  const result = await ctx.cui.runItemAction(current.slug, itemId, action.id, params);
  ctx.mutatePending.value = false;
  if (!result.ok) {
    if (ctx.mutateModal.value) ctx.mutateError.value = result.error;
    else ctx.actionError.value = result.error;
    return false;
  }
  if (result.data.written && ctx.viewing.value && rowIdOf(current.schema.primaryKey, ctx.viewing.value) === itemId) {
    ctx.viewing.value = result.data.item;
  }
  return true;
}

export async function submitMutateParams(ctx: CollectionActionContext, params: Record<string, unknown>): Promise<void> {
  const open = ctx.mutateModal.value;
  if (!open) return;
  ctx.mutateError.value = null;
  if (await executeMutate(ctx, open.action, open.itemId, params)) ctx.mutateModal.value = null;
}

/** Mutate kind: open the params mini-form when the action declares one, else
 *  apply the declarative write immediately. */
async function runMutateAction(ctx: CollectionActionContext, action: CollectionMutateAction, itemId: string): Promise<void> {
  ctx.actionError.value = null;
  if (action.params && Object.keys(action.params).length > 0) {
    ctx.mutateError.value = null;
    ctx.mutateModal.value = { action, itemId };
    return;
  }
  await executeMutate(ctx, action, itemId, {});
}

/** Run a schema-declared action on the open record. `kind: "mutate"` never leaves
 *  the host; `kind: "chat"` starts a new chat; `kind: "agent"` is dispatched
 *  server-side as a hidden worker. */
export async function runAction(ctx: CollectionActionContext, action: CollectionAction): Promise<void> {
  const current = ctx.collection.value;
  if (!current || !ctx.viewing.value) return;
  const itemId = rowIdOf(current.schema.primaryKey, ctx.viewing.value);
  if (!itemId || isActionRunning(ctx.guard, action.id, itemId)) return;
  if (action.kind === "mutate") {
    await runMutateAction(ctx, action, itemId);
    return;
  }
  // Optimistic key BEFORE the POST — see runCollectionAction.
  const runKey = action.kind === "agent" ? agentActionRunKey(action.id, itemId) : null;
  if (runKey) ctx.guard.mutate((next) => next.add(runKey));
  ctx.actionPending.value = true;
  ctx.actionError.value = null;
  const result = await ctx.cui.runItemAction(current.slug, itemId, action.id);
  ctx.actionPending.value = false;
  if (!result.ok) {
    if (runKey && result.status !== 409) ctx.guard.mutate((next) => next.delete(runKey));
    ctx.actionError.value = result.error;
    return;
  }
  if (result.data.dispatched) return; // key already set; the completion ping's refetch reconciles
  if (result.data.written) return; // mutate never reaches this branch; narrows the union
  dispatchPrompt(ctx, result.data.prompt, result.data.role);
}
