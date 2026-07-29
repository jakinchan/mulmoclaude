// MulmoClaude's binding of the shared by-path file access (presentDocument /
// presentHtml's `path` argument) to this host's workspace root.
//
// The rules — what a `path` may be, how it resolves, why there is deliberately
// no containment check, and why `write` refuses to create — live in
// `@mulmoclaude/core/files` (`byPath.ts`), shared with MulmoTerminal so one tool
// call cannot mean two different things in the two apps. This file only supplies
// the root.

import { createByPathFileOps, existsAsFile as coreExistsAsFile, resolveByPath as coreResolveByPath } from "@mulmoclaude/core/files";
import type { FileOps } from "gui-chat-protocol";
import { workspacePath } from "../../workspace/workspace.js";

export { HTML_EXTENSIONS, MARKDOWN_EXTENSIONS } from "@mulmoclaude/core/files";

const rootFor = () => workspacePath;

/** Absolute on-disk path for a caller-supplied path, or null when unusable. */
export function resolveByPath(value: string, extensions: readonly string[]): string | null {
  return coreResolveByPath(rootFor(), value, extensions);
}

/** True when the path names an existing regular file. */
export async function existsAsFile(value: string, extensions: readonly string[]): Promise<boolean> {
  return coreExistsAsFile(rootFor(), value, extensions);
}

/** `FileOps` over caller-supplied paths — the host's `files.byPath` capability. */
export function makeByPathFileOps(extensions: readonly string[]): FileOps {
  return createByPathFileOps({ rootFor, extensions }) as FileOps;
}
