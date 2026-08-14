// Thin host binding over the shared `manageCollection` tool
// (@mulmoclaude/core/collection/server — see manageTool.ts there for the
// full contract). Only the host specifics live here:
//   - bundledHelpsDir: workspace-setup's helpsAssetDir (ESM-only module,
//     so the core tool takes it injected rather than importing it),
//   - ablateValidation from this host's evaluation env, and
//   - the post-putSchema refresh (scheduled skills, user tasks and a
//     newly declared calendar's first sync are MulmoClaude-side state a
//     schema edit can change; the refreshers are the same ones
//     /api/config/refresh wraps, loaded lazily to keep this module's
//     static import graph light).
// The re-exported factory pre-binds bundledHelpsDir so tests keep the
// pre-extraction contract (tmpdir workspace, bundled schemaDocs fallback).

import { makeManageCollectionTool as makeCoreTool, type ManageCollectionDeps } from "@mulmoclaude/core/collection/server";
import { helpsAssetDir } from "@mulmoclaude/core/workspace-setup";
import { isAblated } from "../../system/env.js";

export { MAX_UNSELECTIVE_ITEMS, MAX_SCHEMA_ISSUES, MAX_PUT_ITEMS, type ManageCollectionDeps } from "@mulmoclaude/core/collection/server";

/** Best-effort post-write refresh. Discovery re-reads schema.json from
 *  disk on every call, so a failed refresh only delays the live UI
 *  update — never the data. */
async function defaultRefresh(): Promise<void> {
  const [{ refreshScheduledSkills }, { refreshUserTasks }, { startInitialCalendarSync }] = await Promise.all([
    import("../../workspace/skills/scheduler.js"),
    import("../../workspace/skills/user-tasks.js"),
    import("../../services/google/initialCalendarSync.js"),
  ]);
  // An edit can ADD a `googleCalendar` block to an existing collection, which
  // is as much a "never synced" state as a fresh create (#2427). Fire-and-forget
  // inside the tool call — a first sync walks the whole calendar.
  startInitialCalendarSync();
  await Promise.all([refreshScheduledSkills(), refreshUserTasks()]);
}

/** The core factory with this host's bundled-docs dir pre-bound (still
 *  overridable via deps, like every other injection). */
export function makeManageCollectionTool(deps: ManageCollectionDeps = {}): ReturnType<typeof makeCoreTool> {
  return makeCoreTool({ bundledHelpsDir: helpsAssetDir, ...deps });
}

export const manageCollection = makeManageCollectionTool({
  ablateValidation: isAblated("validation") || undefined,
  refreshAfterWrite: defaultRefresh,
});
