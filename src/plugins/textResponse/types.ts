/**
 * Text Response Plugin - Type Definitions
 */

import type { AttachmentEntry } from "../../types/attachment";

export interface TextResponseData {
  text: string;
  role?: "assistant" | "system" | "user";
  transportKind?: string;
  // Files the user attached when sending this turn (paste/drop/
  // file-picker). Persisted on the user message so the chat history can
  // render an icon / thumbnail chip alongside the bubble. Empty /
  // undefined for assistant and system turns. Already normalised by
  // `makeTextResult` — the pre-#2308 bare-string shape never reaches here.
  attachments?: AttachmentEntry[];
  /** Original (un-rewritten) markdown source for PDF generation.
   *  When present, `downloadPdf` sends this to the server instead of
   *  the displayed `text` (which may have already been rewritten with
   *  `/api/files/raw?path=...` URLs that the PDF inliner can't
   *  resolve). Files Explorer's .md preview sets this; chat callers
   *  leave it undefined and fall back to `text`. */
  pdfSourceText?: string;
  /** Workspace-relative directory of the source file. Forwarded to
   *  `usePdfDownload({ baseDir })` so server-side image inlining
   *  resolves relative refs against the right base. */
  pdfBaseDir?: string;
  /** Strip a leading YAML frontmatter envelope before rendering the
   *  PDF. Set true for Wiki pages (frontmatter shouldn't appear on
   *  page 1 of the PDF); leave false for chat / generic markdown so
   *  documents that literally start with `---\n…\n---\n` survive. */
  pdfStripFrontmatter?: boolean;
  /** Pkg name of the plugin that seeded this user turn via
   *  `runtime.chat.start()` (Phase 1 of the Encore plan). Set on the
   *  first user message in a session whose origin is `plugin:<pkg>`,
   *  drives the "from <pkg>" chip + muted background in the chat
   *  view so the user can tell the message came from a plugin, not
   *  themselves. Undefined for human-sent and assistant turns. */
  seededByPlugin?: string;
}

export type TextResponseArgs = TextResponseData;
