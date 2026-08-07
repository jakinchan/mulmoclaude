// Type declarations for audit-releases.mjs. Kept as a sidecar so the script
// itself stays plain JS (runnable with `node` on a fresh clone, no build step)
// while tests still get a typed import surface — same arrangement as
// scripts/mulmoclaude/deps.d.mts.

/** A workspace manifest plus the directory it was read from. */
export interface AuditedPackage {
  /** Repo-relative package directory, e.g. `packages/plugins/chart-plugin`. */
  dir: string;
  name?: string;
  version?: string;
  files?: string[];
}

/** Sources that feed a package's tarball from outside its own directory, keyed by package name. */
export const EXTERNAL_SOURCE_ROOTS: Record<string, string[]>;

/** Repo-root-relative roots this package ships from outside `dir`. Empty for all but the launcher. */
export function externalSourceRoots(pkg: AuditedPackage): string[];

/** Pathspec `git diff` must cover to see everything this package ships. */
export function diffPathspec(pkg: AuditedPackage): string[];

/** `files` entries normalised to bare directory roots (globs, `./` and trailing slashes stripped). */
export function shippedRoots(pkg: Pick<AuditedPackage, "files">): string[];

/** Whether a repo-relative changed file ends up in this package's published tarball. */
export function isReleasePath(pkg: AuditedPackage, file: string): boolean;

/** CLI entry point. Returns 0 when every workspace could be checked, 1 otherwise. */
export function main(argv?: string[]): number;
