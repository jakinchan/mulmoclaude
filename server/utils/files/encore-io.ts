// Single fs gateway for the Encore plugin. All reads / writes
// against `data/plugins/encore/...` route through here so callers
// don't sprinkle raw fs / path joins around (CLAUDE.md rule). All
// writes use `writeFileAtomic` so partial writes can't corrupt the
// on-disk DSL or cycle state.
//
// Domain-agnostic helpers only (read text, write text, read dir,
// exists, unlink). Markdown frontmatter parsing / serialization
// lives next to the consumers in src/plugins/encore/.

import { promises as fsPromises } from "node:fs";
import path from "node:path";

import { workspacePath, WORKSPACE_DIRS } from "../../workspace/paths.js";
import { writeFileAtomic } from "./atomic.js";
import { isEnoent } from "./safe.js";

const root = (workspaceRoot?: string): string => workspaceRoot ?? workspacePath;

/** Absolute path to the Encore plugin's data directory. */
export function encoreRoot(workspaceRoot?: string): string {
  return path.join(root(workspaceRoot), WORKSPACE_DIRS.encore);
}

/** Join a workspace-relative encore path (from paths.ts) to the
 *  absolute on-disk location. */
function abs(rel: string, workspaceRoot?: string): string {
  return path.join(encoreRoot(workspaceRoot), rel);
}

/** Read a text file under the Encore tree. Returns `null` if the
 *  file doesn't exist (vs. throwing on ENOENT) — callers usually
 *  want the missing-file case as "no such obligation" rather than
 *  an error. */
export async function readTextOrNull(rel: string, workspaceRoot?: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(abs(rel, workspaceRoot), "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** Write text atomically; creates parent directories as needed. */
export async function writeText(rel: string, content: string, workspaceRoot?: string): Promise<void> {
  const target = abs(rel, workspaceRoot);
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, content);
}

/** True iff the path exists (file or dir). */
export async function exists(rel: string, workspaceRoot?: string): Promise<boolean> {
  try {
    await fsPromises.stat(abs(rel, workspaceRoot));
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/** List directory entries (basenames only). Empty array if the
 *  directory doesn't exist — easier than threading ENOENT through
 *  every list call. */
export async function readDir(rel: string, workspaceRoot?: string): Promise<string[]> {
  try {
    return await fsPromises.readdir(abs(rel, workspaceRoot));
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/** Remove a file. No-op if it doesn't exist (matches the semantics
 *  callers want when sweeping orphan tickets). */
export async function unlink(rel: string, workspaceRoot?: string): Promise<void> {
  try {
    await fsPromises.unlink(abs(rel, workspaceRoot));
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
}
