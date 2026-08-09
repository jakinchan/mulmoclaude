// Host injection seam for the Feeds engine — mirrors `configureCollectionHost`
// / `configureScheduler`. The engine is host-agnostic: the workspace root, the
// logger, an atomic file writer, and the hidden/visible agent-ingest worker
// launcher are injected once at boot via `configureFeedsHost`. Everything else
// the engine needs (collection IO, the notifier) is a sibling `@mulmoclaude/core`
// subpath, imported directly. Both MulmoClaude and MulmoTerminal supply their
// own host shim.

import { createForwardingLogger, createHostSlot, type StructuredLogger } from "../../host/hostSlot.js";

/** Outcome of launching one hidden/visible agent-ingest worker. `chatId` lets
 *  the caller register a completion hook so a failed refresh doesn't die
 *  silently. */
export type AgentWorkerResult = { ok: true; chatId: string } | { ok: false; error: string };

/** Launches a worker chat. Injected at boot to keep the feeds engine from
 *  importing a host's routes/session layer. `hidden` chooses an invisible
 *  system worker (scheduled refresh) vs a visible session the user can watch
 *  (manual Refresh — debuggable). `onComplete` is a one-shot completion hook
 *  (only honoured for hidden workers) so the dispatcher learns success/failure.
 *  Returns `ok:false` on the concurrency-cap miss or a launch error — the caller
 *  leaves state untouched and retries next tick. */
export type AgentWorkerRunner = (args: {
  message: string;
  roleId: string;
  hidden: boolean;
  /** Absolute root this refresh is for — the root `refreshViaAgent` was called
   *  with, forwarded because the seed prompt's `dataPath` is RELATIVE to it.
   *
   *  A multi-root host must spawn the worker THERE (as its cwd), or the worker
   *  resolves `data/collections/<slug>/items` against whatever root it happens
   *  to run in and writes another project's records — silently, since both
   *  paths exist and neither side errors.
   *
   *  Optional so a single-workspace host's runner (MulmoClaude's) can ignore it
   *  and behave exactly as before: there is only one root, and it is the one the
   *  worker already runs in. */
  workspaceRoot?: string | undefined;
  onComplete?: ((outcome: { didError: boolean }) => void | Promise<void>) | undefined;
}) => Promise<AgentWorkerResult>;

/** Public alias of the shared `StructuredLogger` — same shape as `CollectionLogger`. */
export type FeedsLogger = StructuredLogger;

export interface FeedsHost {
  /** Absolute workspace root — the default for `refreshDue()` and state paths. */
  workspaceRoot: string;
  /** Host logger. */
  log: FeedsLogger;
  /** Host atomic file writer (state files). */
  writeFileAtomic: (filePath: string, content: string) => Promise<void>;
  /** Launches the agent-ingest worker (was `setAgentWorkerRunner`). */
  spawnWorker: AgentWorkerRunner;
}

const hostSlot = createHostSlot<FeedsHost>("@mulmoclaude/core/feeds: configureFeedsHost()");

/** Wire the feeds engine to a host. Call once at startup, before any refresh. */
export function configureFeedsHost(host: FeedsHost): void {
  hostSlot.set(host);
}

/** The configured host, or throw if `configureFeedsHost` was never called. */
export function requireFeedsHost(): FeedsHost {
  return hostSlot.get();
}

/** Test-only: clear the configured host. */
export function resetFeedsHostForTesting(): void {
  hostSlot.reset();
}

/** Forwarding logger so engine modules can `import { log }` without each
 *  reaching for `requireFeedsHost().log`. Non-critical: calls before the host
 *  is wired are dropped (not thrown), matching the collection/google seams. */
export const log: FeedsLogger = createForwardingLogger(() => hostSlot.peek()?.log ?? null);
