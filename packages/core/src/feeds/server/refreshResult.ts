// Shared result shape for a single collection refresh, in its own module so
// both the engine (declarative path) and the agent-ingest dispatcher can use
// it without forming an `engine.ts` ↔ `agentIngest.ts` import cycle.

export interface RefreshResult {
  slug: string;
  /** Records written this run. Always 0 for agent ingest (the worker writes
   *  records asynchronously, after this returns). */
  written: number;
  /** Old records deleted by the maxItems cap this run. */
  removed: number;
  errors: string[];
  /** True when an agent-ingest run dispatched a worker (fire-and-forget): the
   *  records update later when the worker finishes. Absent/false for declarative
   *  feeds, which write records synchronously before returning. */
  dispatched?: boolean | undefined;
  /** The dispatched worker's chat session id. Set only for a VISIBLE (manual)
   *  agent-ingest run so the client can open the session to watch it; absent for
   *  hidden scheduled runs and declarative feeds. */
  chatId?: string | undefined;
}
