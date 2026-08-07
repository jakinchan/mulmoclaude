// Type declarations for check-changelog-ships.mjs. Sidecar so the script stays
// plain JS (runnable with `node` on a fresh clone) while tests get a typed
// import surface — same arrangement as scripts/packages/audit-releases.d.mts.

export interface LauncherManifest {
  version?: string;
  dependencies?: Record<string, string>;
}

/** The `@mulmoclaude/*` roster the launcher declares, as sorted `name@version` strings. */
export function declaredRoster(manifest: LauncherManifest): string[];

/** The `## [X.Y.Z]` section body, or null when the CHANGELOG has no such heading. */
export function releaseSection(changelog: string, version: string): string | null;

/** The roster the section's `Ships …` line claims, sorted. Null when there is no such line. */
export function claimedRoster(section: string): string[] | null;

/** Entries the line forgot (`missing`) and entries it kept but the launcher dropped (`stale`). */
export function compareRosters(claimed: string[], declared: string[]): { missing: string[]; stale: string[] };

/** CLI entry point. Returns 0 when the line matches the launcher's dependencies, 1 otherwise. */
export function main(): number;
