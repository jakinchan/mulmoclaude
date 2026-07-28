import { access, readFile } from "fs/promises";
import path from "path";
import { workspacePath } from "../../workspace/workspace.js";
import { WORKSPACE_DIRS } from "../../workspace/paths.js";
import { writeFileAtomic } from "./atomic.js";
import { buildArtifactPathRandom } from "./naming.js";
import { makePathValidator } from "./path-validator.js";

// Random-id suffix prevents collisions between concurrent writers sharing a prefix; #764 sharded under YYYY/MM.
export async function saveMarkdown(content: string, prefix: string): Promise<string> {
  const relPath = buildArtifactPathRandom(WORKSPACE_DIRS.markdowns, prefix, ".md", "document");
  const absPath = path.join(workspacePath, relPath);
  await writeFileAtomic(absPath, content);
  return relPath;
}

export async function loadMarkdown(relativePath: string): Promise<string> {
  const absPath = path.join(workspacePath, relativePath);
  return readFile(absPath, "utf-8");
}

// Strict — overwriteMarkdown's path.join doesn't normalize traversal, so this gate is the primary defence.
export const isMarkdownPath = makePathValidator({ prefix: WORKSPACE_DIRS.markdowns, ext: ".md" });

// Existence probe for presentDocument's `path` form. Gated on isMarkdownPath
// first for the same traversal reason as overwriteMarkdown.
export async function markdownExists(relativePath: string): Promise<boolean> {
  if (!isMarkdownPath(relativePath)) return false;
  try {
    await access(path.join(workspacePath, relativePath));
    return true;
  } catch {
    return false;
  }
}

// Defense in depth (matches `overwriteSvg`): if a caller forgets to
// pre-check via `isMarkdownPath`, `path.join(workspacePath, relativePath)`
// would silently produce a traversal escape. The re-check inside the
// write closes that trust chain.
export async function overwriteMarkdown(relativePath: string, content: string): Promise<void> {
  if (!isMarkdownPath(relativePath)) {
    throw new Error(`invalid markdown path: ${relativePath}`);
  }
  const absPath = path.join(workspacePath, relativePath);
  await writeFileAtomic(absPath, content);
}
