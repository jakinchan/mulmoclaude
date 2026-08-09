// Agent-performed ingest (`ingest.kind: "agent"`). On schedule (or a manual
// Refresh), the host seeds a hidden background worker — origin `system`, so
// it never appears in the user's session list — in the collection's declared
// role with its template + a summary of every record, and the worker edits the
// records itself via the collections io layer. The host stays domain-free:
// everything stock-specific (or whatever the collection does) is prose in the
// template.
//
// DI seam: the worker is launched through `FeedsHost.spawnWorker`, injected at
// boot via `configureFeedsHost`, not imported directly — this module ships in a
// shared package and must not reach into any host's session/routes layer.

import { listItems, promptPathsFor, readSkillTemplate, buildCollectionActionSeedPrompt, type LoadedCollection } from "../../collection/server/index.js";
import { publish as publishNotifier, clear as clearNotifier } from "../../notifier/index.js";
import { log, requireFeedsHost, type AgentWorkerResult, type AgentWorkerRunner } from "./host.js";
import { readFeedState, writeFeedState, type FeedState } from "./state.js";
import { AGENT_INGEST_KIND } from "../ingestTypes.js";
import type { RefreshResult } from "./refreshResult.js";

export type { AgentWorkerResult, AgentWorkerRunner } from "./host.js";

/** The injected worker launcher, or null if the host was never configured.
 *  Read non-throwingly so the failure-isolated contract holds (an unconfigured
 *  host becomes an `errors` entry, not a thrown exception). */
function workerRunnerOrNull(): AgentWorkerRunner | null {
  try {
    return requireFeedsHost().spawnWorker;
  } catch {
    return null;
  }
}

function result(slug: string, patch: Partial<RefreshResult>): RefreshResult {
  return { slug, written: 0, removed: 0, errors: [], ...patch };
}

/** Dispatch one agent-ingest refresh: build the seed, launch a worker, and (on a
 *  successful launch) stamp `lastFetchedAt` with the DISPATCH time — not
 *  completion. That's what gates the due-loop, so a slow worker can't cause a
 *  double-dispatch. `opts.hidden` (default true) runs an invisible system worker
 *  for SCHEDULED refreshes; a MANUAL Refresh passes `hidden:false` for a visible,
 *  debuggable session. Failure-isolated: never throws; cap-miss / template-miss /
 *  launch error leave state untouched and report via `errors`. */
export async function refreshViaAgent(workspaceRoot: string, collection: LoadedCollection, opts?: { hidden?: boolean }): Promise<RefreshResult> {
  const hidden = opts?.hidden ?? true;
  const { slug } = collection;
  const { ingest } = collection.schema;
  if (ingest?.kind !== AGENT_INGEST_KIND) return result(slug, { errors: ["collection has no agent ingest config"] });
  const workerRunner = workerRunnerOrNull();
  if (!workerRunner) return result(slug, { errors: ["agent ingest worker runner not configured"] });

  const template = await readSkillTemplate(collection.skillDir, ingest.template);
  if (template === null) return result(slug, { errors: [`ingest template '${ingest.template}' could not be read`] });

  const items = await listItems(collection.dataDir, { workspaceRoot });
  // Thread the canonical, host-normalized paths through the seed so the
  // template can pass `--out-dir data/collections/<slug>/items` (etc.) into
  // any bundled script instead of relying on the script's `argparse` default —
  // which was written for the author's pre-import layout, NOT the R3-
  // normalized location the host actually reads records from. Fixes #1891.
  const message = buildCollectionActionSeedPrompt(items, collection.schema, template, promptPathsFor(collection, workspaceRoot));

  // The runner is injected, so guard its promise here to honour the
  // failure-isolated contract (a rejection must become an `errors` entry, not
  // escape into the scheduler loop / route handler).
  let launch: AgentWorkerResult;
  try {
    launch = await workerRunner({
      message,
      roleId: ingest.role,
      hidden,
      // The seed prompt addresses records root-relatively (`promptPathsFor`), so
      // the root travels WITH it: a multi-root host spawns the worker there. A
      // single-workspace host ignores the field — same root either way.
      workspaceRoot,
      // A visible manual run is watched directly — only hidden runs get the
      // completion hook (failure bell + consecutiveFailures); `finalizeRun` only
      // fires it for system-origin sessions anyway.
      onComplete: hidden ? (outcome) => recordOutcome(workspaceRoot, collection, outcome.didError) : undefined,
    });
  } catch (err) {
    log.warn("feeds", "agent ingest worker launch threw", { slug, error: String(err) });
    return result(slug, { errors: [String(err)], dispatched: false });
  }
  if (!launch.ok) {
    // Cap-miss or launch error: do NOT touch lastFetchedAt — the next due tick
    // (or manual Refresh) redials. Surface it so a manual refresh reads honest.
    log.info("feeds", "agent ingest dispatch skipped", { slug, error: launch.error });
    return result(slug, { errors: [launch.error], dispatched: false });
  }

  const state = await readFeedState(workspaceRoot, collection);
  await writeFeedState(workspaceRoot, collection, { ...state, lastFetchedAt: new Date().toISOString() });
  log.info("feeds", "agent ingest dispatched", { slug, role: ingest.role, chatId: launch.chatId, hidden, items: items.length });
  // Surface the chatId only for a visible run so the client can open it; a hidden
  // session is excluded from every listing and can't be navigated to anyway.
  return result(slug, { dispatched: true, ...(hidden ? {} : { chatId: launch.chatId }) });
}

/** Completion hook: reconcile failure tracking when a dispatched worker
 *  finishes. On error, bump `consecutiveFailures` and raise a single failure
 *  bell (deduped via the persisted `failureBellId`). On success, reset the
 *  counter and clear any standing bell. Best-effort + failure-isolated — it
 *  runs inside the agent run's teardown, so it must never throw. */
async function recordOutcome(workspaceRoot: string, collection: LoadedCollection, didError: boolean): Promise<void> {
  const state = await readFeedState(workspaceRoot, collection);
  const next: FeedState = didError ? await onWorkerError(state, collection) : await onWorkerSuccess(state, collection);
  await writeFeedState(workspaceRoot, collection, next);
}

async function onWorkerError(state: FeedState, collection: LoadedCollection): Promise<FeedState> {
  const next: FeedState = { ...state, consecutiveFailures: state.consecutiveFailures + 1 };
  log.warn("feeds", "agent ingest worker failed", { slug: collection.slug, consecutiveFailures: next.consecutiveFailures });
  // Raise a single bell on the first failure; a standing one isn't piled onto.
  if (!state.failureBellId) {
    try {
      const { id } = await publishNotifier({
        pluginPkg: "host",
        severity: "nudge",
        lifecycle: "fyi",
        title: "Collection refresh failed",
        body: `“${collection.schema.title}” (${collection.slug}) couldn't refresh. Open it to retry.`,
        navigateTarget: `/collections/${collection.slug}`,
      });
      next.failureBellId = id;
    } catch (err) {
      log.warn("feeds", "failed to publish ingest failure bell", { slug: collection.slug, error: String(err) });
    }
  }
  return next;
}

async function onWorkerSuccess(state: FeedState, collection: LoadedCollection): Promise<FeedState> {
  log.info("feeds", "agent ingest worker completed", { slug: collection.slug });
  if (state.failureBellId) {
    await clearNotifier(state.failureBellId).catch((err) =>
      log.warn("feeds", "failed to clear ingest failure bell", { slug: collection.slug, error: String(err) }),
    );
  }
  const next: FeedState = { ...state, consecutiveFailures: 0 };
  delete next.failureBellId;
  return next;
}
