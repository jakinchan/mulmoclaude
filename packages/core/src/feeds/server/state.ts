// Per-collection retrieval state — when we last fetched/dispatched, the
// retriever's cursor (for incremental fetches), and a consecutive-failure
// counter. NOT committed to git. Location depends on the collection's source:
// feeds keep it alongside the schema at `<workspace>/feeds/<slug>/_state.json`;
// skill-backed collections with `ingest.kind: "agent"` store it at
// `<workspace>/data/ingest-state/<slug>.json` (a schema-less `feeds/<slug>/`
// dir would confuse feed discovery, and `_state.json` must never live in a
// collection's dataDir where `listItems` would read it as a record).
// Deliberately minimal: the legacy `sources` tree carries richer backoff
// state, but the engine starts simple and grows on real need.

import { isErrorWithCode, isRecord } from "@mulmoclaude/common";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CollectionSource } from "../../collection/index.js";
import { log, requireFeedsHost } from "./host.js";
import { feedStatePath, ingestStatePath } from "../paths.js";

/** Minimal shape needed to locate a collection's state file. `LoadedCollection`
 *  satisfies it. */
export interface StateTarget {
  slug: string;
  source: CollectionSource;
}

/** Resolve the on-disk state file for a collection, branching on source. */
function stateFilePath(target: StateTarget, workspaceRoot: string): string {
  return target.source === "feed" ? feedStatePath(target.slug, workspaceRoot) : ingestStatePath(target.slug, workspaceRoot);
}

export interface FeedState {
  slug: string;
  /** ISO timestamp of the last successful fetch (declarative) or dispatch
   *  (agent ingest), or null if never. */
  lastFetchedAt: string | null;
  /** Free-form retriever cursor (e.g. last-seen id / etag). */
  cursor: Record<string, string>;
  /** Consecutive failed fetches/runs; reset to 0 on success. */
  consecutiveFailures: number;
  /** Agent ingest only: the notifier entry id of the active "refresh failed"
   *  bell, so a later success can clear exactly that entry. Absent when no
   *  failure bell is showing. */
  failureBellId?: string;
}

export function defaultFeedState(slug: string): FeedState {
  return { slug, lastFetchedAt: null, cursor: {}, consecutiveFailures: 0 };
}

function normalizeState(slug: string, parsed: Record<string, unknown>): FeedState {
  const base = defaultFeedState(slug);
  const cursor = parsed.cursor && typeof parsed.cursor === "object" ? (parsed.cursor as Record<string, string>) : base.cursor;
  return {
    slug,
    lastFetchedAt: typeof parsed.lastFetchedAt === "string" ? parsed.lastFetchedAt : base.lastFetchedAt,
    cursor,
    consecutiveFailures: typeof parsed.consecutiveFailures === "number" ? parsed.consecutiveFailures : base.consecutiveFailures,
    ...(typeof parsed.failureBellId === "string" ? { failureBellId: parsed.failureBellId } : {}),
  };
}

/** Read a collection's retrieval state, tolerating a missing file (first run →
 *  default). The state path branches on `target.source`. */
export async function readFeedState(workspaceRoot: string, target: StateTarget): Promise<FeedState> {
  const { slug } = target;
  try {
    const raw = await readFile(stateFilePath(target, workspaceRoot), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    // A non-object state file has no fields to read, so it normalises to the
    // same default `normalizeState` would produce from an empty record.
    return normalizeState(slug, isRecord(parsed) ? parsed : {});
  } catch (err) {
    if (!isErrorWithCode(err) || err.code !== "ENOENT") {
      log.warn("feeds", "failed to read feed state, using default", { slug, error: String(err) });
    }
    return defaultFeedState(slug);
  }
}

/** Persist a collection's retrieval state atomically (creating the parent dir
 *  if needed). The state path branches on `target.source`. */
export async function writeFeedState(workspaceRoot: string, target: StateTarget, state: FeedState): Promise<void> {
  const file = stateFilePath(target, workspaceRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await requireFeedsHost().writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}
