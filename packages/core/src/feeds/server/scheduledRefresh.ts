// Shareable registration for the hourly "refresh due collections" task.
// Both MulmoClaude (via `initScheduler`, with persistence + catch-up) and a
// standalone MulmoTerminal/MulmoBooks (via a bare task-manager `registerTask`)
// register the SAME definition through this factory, so the id/schedule/run
// can't drift between hosts. See plans/done/feat-shareable-feed-refresh-registration.md.
import { SCHEDULE_TYPES, MISSED_RUN_POLICIES } from "@receptron/task-scheduler";
import type { SystemTaskDef } from "../../scheduler/adapter.js";
import { refreshDue } from "./engine.js";

// Id kept stable so the scheduler-state row isn't orphaned across hosts/renames.
export const FEED_REFRESH_TASK_ID = "system:feed-refresh";

/** The task id for a given root. Root-less (the configured workspace) keeps the
 *  bare, historical id, so a single-workspace host's persisted scheduler state
 *  keeps matching. A per-root registration gets its own id — a task id is the
 *  scheduler's primary key, so N roots registered under one id would collide
 *  and only the last would ever run. */
export function feedRefreshTaskId(workspaceRoot?: string): string {
  return workspaceRoot === undefined ? FEED_REFRESH_TASK_ID : `${FEED_REFRESH_TASK_ID}:${workspaceRoot}`;
}
// Single source of truth for the default refresh cadence (one hour). Core has no
// shared time module — `server/utils/time.ts` is host-only — so the named export
// IS the constant; hosts override via `feedRefreshTaskDef({ intervalMs })`.
export const DEFAULT_FEED_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The hourly "refresh due collections" task, shared by every host.
 *
 * Drives ALL scheduled ingest: declarative feeds (RSS / JSON) fetch directly,
 * and skill-backed `ingest.kind: "agent"` collections dispatch a hidden worker.
 *
 * Returns the rich `SystemTaskDef` rather than registering it — each host keeps
 * its own registration mechanism and applies its own schedule overrides first.
 * A host driving a bare task-manager can still `registerTask(...)` it; the extra
 * `missedRunPolicy` field is simply ignored there.
 *
 * ROOT-PARAMETERISED. Called with no `workspaceRoot` it refreshes the host's
 * configured workspace under the historical task id — unchanged, and what a
 * single-workspace host wants. A multi-root host registers ONE def per root it
 * wants refreshed on a schedule; each gets its own id (see `feedRefreshTaskId`)
 * so the registrations do not overwrite each other. A root that is never
 * registered is never refreshed on a schedule — its feeds update only on an
 * explicit call — so registering per project is the host's decision to make,
 * deliberately, rather than something this module can infer.
 *
 * @param opts.intervalMs   per-host interval override (defaults to one hour)
 * @param opts.workspaceRoot the root to refresh; omitted, the configured FeedsHost workspace
 */
export function feedRefreshTaskDef(opts?: { workspaceRoot?: string; intervalMs?: number }): SystemTaskDef {
  return {
    id: feedRefreshTaskId(opts?.workspaceRoot),
    name: opts?.workspaceRoot === undefined ? "Scheduled collection refresh" : `Scheduled collection refresh (${opts.workspaceRoot})`,
    description: "Refresh due collections — fetch declarative feeds + dispatch agent-ingest workers",
    schedule: { type: SCHEDULE_TYPES.interval, intervalMs: opts?.intervalMs ?? DEFAULT_FEED_REFRESH_INTERVAL_MS },
    missedRunPolicy: MISSED_RUN_POLICIES.runOnce,
    run: () => refreshDue(opts?.workspaceRoot).then(() => {}),
  };
}
