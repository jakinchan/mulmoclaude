// @mulmoclaude/core/feeds/server — server-only public surface of the Feeds
// retrieval engine. Hosts (MulmoClaude, MulmoTerminal) drive refresh through
// here after wiring `configureFeedsHost` once at boot. Routes + the scheduler
// task import from this module.

export { listFeeds, removeFeed } from "./registry.js";
export { refreshOne, refreshDue, hasLocalContent, ingestedFields, type RefreshResult } from "./engine.js";
export { feedRefreshTaskDef, feedRefreshTaskId, FEED_REFRESH_TASK_ID, DEFAULT_FEED_REFRESH_INTERVAL_MS } from "./scheduledRefresh.js";
export { refreshViaAgent } from "./agentIngest.js";
export { readFeedState, type FeedState } from "./state.js";
export { feedsRoot, feedDir, feedStatePath, ingestStateDir, ingestStatePath, FEEDS_DIR } from "../paths.js";
export {
  AGENT_INGEST_KIND,
  DEFAULT_FEED_MAX_ITEMS,
  INGEST_KINDS,
  FEED_SCHEDULES,
  isFeedSchedule,
  type IngestSpec,
  type DeclarativeIngestSpec,
  type AgentIngestSpec,
  type IngestKind,
  type FeedSchedule,
} from "../ingestTypes.js";

// Host injection seam (DI). `setAgentWorkerRunner` is folded into
// `configureFeedsHost({ spawnWorker })`.
export {
  configureFeedsHost,
  requireFeedsHost,
  resetFeedsHostForTesting,
  type FeedsHost,
  type FeedsLogger,
  type AgentWorkerRunner,
  type AgentWorkerResult,
} from "./host.js";
