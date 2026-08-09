// The canonical form of a workspace / project root.
//
// Lives here rather than in the collection engine because a root is an IDENTITY
// in several subsystems that do not depend on each other — a watcher generation
// key, a change payload, a completion-bell id, a scheduled task id — and every
// one of them has to agree on it or the same project registers twice.

import path from "node:path";

/** The canonical form of a root, for every place a root becomes an IDENTITY
 *  rather than a path to read.
 *
 *  `path.resolve` only — it collapses `.`/`..` and the trailing separator, so
 *  `/work/project` and `/work/project/` are one root instead of two watcher
 *  generations over the same tree, two bells per record, and two scheduled
 *  refresh jobs.
 *
 *  Deliberately NOT `realpath`. Resolving symlinks is async (so it could not run
 *  on a synchronous claim path), it fails for a root that does not exist yet,
 *  and it would put a path the host never named into an id that is written to
 *  disk. The policy is therefore lexical: a host that hands the same tree under
 *  two different symlink spellings gets two roots, and it is the host's job to
 *  name a project the same way every time. */
export function canonicalRoot(root: string): string {
  return path.resolve(root);
}
