// Dispatch for `kind: "agent"` collection actions (plan step ③ of
// plans/done/collection-ontology.md): the button launches a HIDDEN worker
// (origin `system` — never in the session list) seeded exactly like the
// action's chat twin, and the worker edits records via manageCollection
// and finishes silently. The user-facing contract mirrors agent ingest:
//
//   - stamp-at-dispatch guard: the run key is registered BEFORE the
//     worker launches, so a double-click (or a second tab) dispatches
//     ONE worker; the key clears when the worker completes.
//   - deduped failure bell: a failed worker raises one notification per
//     action (not one per failure), cleared by the next success.
//   - completion ping: `publishCollectionChange` fires when the worker
//     finishes — record edits already ping per write, but a failed run
//     writes nothing, and without the ping the client's spinner (driven
//     by the detail response's `runningActions`) would never clear.
//
// Lives in the routes layer because the worker launcher does
// (`spawnSystemWorker` — workspace code must not import routes; see
// server/workspace/feeds/configure.ts). Deps are injectable so the unit
// test drives dispatch/completion without a real agent session.

import { spawnSystemWorker, type SpawnSystemWorkerResult } from "./agent.js";
import { publish as publishNotifier, clear as clearNotifier } from "@mulmoclaude/core/notifier";
import { agentActionRunKey } from "@mulmoclaude/core/collection";
import { publishCollectionChange } from "@mulmoclaude/core/collection/server";
import { log } from "../../system/logger/index.js";
import type { CollectionSeededAction, LoadedCollection } from "../../workspace/collections/index.js";

export { agentActionRunKey };

/** Injectable seams (defaults are the live modules; tests override). */
export interface AgentActionDeps {
  spawn: (args: {
    message: string;
    roleId: string;
    hidden: boolean;
    onComplete?: (outcome: { didError: boolean }) => void | Promise<void>;
  }) => Promise<SpawnSystemWorkerResult>;
  publishChange: (slug: string) => void;
  notifyFailure: (title: string, body: string, slug: string) => Promise<string>;
  clearNotification: (id: string) => Promise<void>;
}

const defaultDeps: AgentActionDeps = {
  spawn: spawnSystemWorker,
  publishChange: (slug) => publishCollectionChange({ slug }),
  notifyFailure: async (title, body, slug) => {
    const { id: bellId } = await publishNotifier({
      pluginPkg: "host",
      severity: "nudge",
      lifecycle: "fyi",
      title,
      body,
      navigateTarget: `/collections/${slug}`,
    });
    return bellId;
  },
  clearNotification: (bellId) => clearNotifier(bellId),
};

// In-flight run keys per collection slug — the dispatch guard AND the
// source of the detail response's `runningActions`. In-memory on purpose:
// workers die with the process, so persisted state would only wedge the
// button after a restart.
const running = new Map<string, Set<string>>();

// Standing failure-bell id per `${slug}\n${runKey}` — one bell per action
// until it succeeds again, mirroring agent ingest's `failureBellId` (which
// persists in feed state; an action has no state file, and losing the id on
// restart merely risks one duplicate bell).
const failureBells = new Map<string, string>();

/** Run keys currently in flight for one collection (detail response). */
export function runningAgentActions(slug: string): string[] {
  return [...(running.get(slug) ?? [])];
}

/** Test-only: drop all in-flight keys and standing bell ids. */
export function resetAgentActionsForTesting(): void {
  running.clear();
  failureBells.clear();
}

function markRunning(slug: string, key: string): void {
  const keys = running.get(slug) ?? new Set<string>();
  keys.add(key);
  running.set(slug, keys);
}

function clearRunning(slug: string, key: string): void {
  const keys = running.get(slug);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) running.delete(slug);
}

/** Completion hook: reconcile the guard + bell, then ping the collection
 *  channel so the client refetches (clearing its spinner even when the
 *  failed worker wrote nothing). Best-effort — runs in the agent run's
 *  teardown and must never throw. */
async function onWorkerComplete(
  collection: LoadedCollection,
  action: CollectionSeededAction,
  key: string,
  didError: boolean,
  deps: AgentActionDeps,
): Promise<void> {
  clearRunning(collection.slug, key);
  const bellKey = `${collection.slug}\n${key}`;
  const existingBell = failureBells.get(bellKey);
  try {
    if (didError && existingBell === undefined) {
      const body = `“${action.label}” on “${collection.schema.title}” (${collection.slug}) failed. Open the collection to retry.`;
      failureBells.set(bellKey, await deps.notifyFailure("Collection action failed", body, collection.slug));
    }
    if (!didError && existingBell !== undefined) {
      await deps.clearNotification(existingBell);
      failureBells.delete(bellKey);
    }
  } catch (err) {
    log.warn("collections", "agent action bell reconcile failed", { slug: collection.slug, key, error: String(err) });
  }
  log[didError ? "warn" : "info"]("collections", "agent action worker finished", { slug: collection.slug, key, didError });
  // Best-effort like everything else in this hook: a throwing publisher
  // must not reject the worker's teardown callback.
  try {
    deps.publishChange(collection.slug);
  } catch (err) {
    log.warn("collections", "agent action completion publish failed", { slug: collection.slug, key, error: String(err) });
  }
}

export type DispatchAgentActionResult = { ok: true } | { ok: false; error: string; alreadyRunning?: boolean };

/** Launch the hidden worker for one `kind: "agent"` action. The caller has
 *  already resolved the action, enforced `when`, and built the seed (the
 *  SAME builders the chat kind uses). Never throws: a cap-miss / launch
 *  error clears the guard and reports `ok: false` so the button un-sticks
 *  and the route answers honestly. */
export async function dispatchAgentAction(
  args: { collection: LoadedCollection; action: CollectionSeededAction; seed: string; itemId?: string },
  deps: AgentActionDeps = defaultDeps,
): Promise<DispatchAgentActionResult> {
  const { collection, action, itemId } = args;
  const key = agentActionRunKey(action.id, itemId);
  if (running.get(collection.slug)?.has(key)) {
    const target = itemId ? ` for '${itemId}'` : "";
    return { ok: false, alreadyRunning: true, error: `action '${action.id}' is already running${target}` };
  }
  // Stamp BEFORE the (async) launch — two concurrent clicks must collapse
  // to one worker, and the launch itself is the slow part.
  markRunning(collection.slug, key);
  let launch: SpawnSystemWorkerResult;
  try {
    launch = await deps.spawn({
      message: args.seed,
      roleId: action.role,
      hidden: true,
      onComplete: (outcome) => onWorkerComplete(collection, action, key, outcome.didError, deps),
    });
  } catch (err) {
    clearRunning(collection.slug, key);
    log.warn("collections", "agent action launch threw", { slug: collection.slug, key, error: String(err) });
    return { ok: false, error: String(err) };
  }
  if (!launch.ok) {
    clearRunning(collection.slug, key);
    log.info("collections", "agent action dispatch refused", { slug: collection.slug, key, error: launch.error });
    return { ok: false, error: launch.error };
  }
  log.info("collections", "agent action dispatched", { slug: collection.slug, key, role: action.role, chatId: launch.chatId });
  return { ok: true };
}
