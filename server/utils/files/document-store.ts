// Read / write access to ANY markdown document, for presentDocument's `path`
// form (#2636 follow-up). Its sibling `markdown-store.ts` stays what it always
// was: the store for documents this app CREATES, which live under
// `artifacts/documents/YYYY/MM/` and are gated by `isMarkdownPath`.
//
// The two are deliberately separate. A path the tool was handed — a repo's
// `README.md`, `docs/design.md`, an absolute path — is a different kind of
// value from a path this app minted, and giving `overwriteMarkdown` a second
// meaning would quietly widen every existing caller of it.
//
// The resolution + overwrite-only rules live in `./by-path.ts`, shared with
// presentHtml's equivalent; this module is the markdown-shaped face of them.

import { existsAsFile, makeByPathFileOps, resolveByPath } from "./by-path.js";

export const MARKDOWN_EXTENSIONS = [".md"] as const;

const documentFiles = makeByPathFileOps(MARKDOWN_EXTENSIONS);

/** Absolute on-disk path for a caller-supplied document path, or null when the
 *  value is not a usable markdown path. */
export function resolveDocumentPath(value: string): string | null {
  return resolveByPath(value, MARKDOWN_EXTENSIONS);
}

/** True when the path names an existing regular markdown file. */
export async function documentExists(value: string): Promise<boolean> {
  return existsAsFile(value, MARKDOWN_EXTENSIONS);
}

export async function loadDocument(value: string): Promise<string> {
  return documentFiles.read(value);
}

/** Overwrite in place — the View's Apply / task-checkbox path. Refuses to
 *  CREATE a document: `presentDocument(path)` only ever presents a file that
 *  already exists, so a write to a path that does not is a bug (a typo in the
 *  path, or a document deleted mid-edit), not a save. */
export async function overwriteDocument(value: string, content: string): Promise<void> {
  await documentFiles.write(value, content);
}
