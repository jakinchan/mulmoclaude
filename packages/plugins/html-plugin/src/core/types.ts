/** Tool-call arguments for presentHtml. `html` and `path` are mutually
 *  exclusive (provide exactly one); `title` is an optional sidebar label. */
export interface HtmlArgs {
  html?: string;
  path?: string;
  title?: string;
}

/** Result payload that drives the View / preview sidebar. The HTML itself
 *  lives on disk (large), so only the workspace-relative `filePath` and an
 *  optional `title` travel in the tool result. */
export interface PresentHtmlData {
  title?: string | undefined;
  filePath: string;
  /** Host-served URL the View points its iframe at so relative asset refs
   *  (`<img src="../../../images/…">`) resolve against the file's real URL.
   *  The HOST injects this (it knows how it serves `artifacts/html/…` — e.g.
   *  MulmoClaude's `/artifacts/html/…` static mount); the package never
   *  hardcodes a host path. Absent ⇒ the View derives the default
   *  `/artifacts/html/…` URL from `filePath` (`htmlArtifactPreviewUrl`), so
   *  results stored before this field existed still render. */
  previewUrl?: string;
}

/** Body of the in-place overwrite path (PUT /api/html/update). */
export interface UpdateHtmlArgs {
  relativePath: string;
  html: string;
}
