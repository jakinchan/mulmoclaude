// Shared splice point for the inline scripts the app injects into
// rendered HTML (iframe height reporter, image repair). Kept in one
// place so the "last `</body>`, else append" rule can't drift between
// them.

const BODY_CLOSE_RE = /<\/body\s*>/gi;

/** Insert `tag` immediately before the LAST `</body>` so it runs after
 *  the document's own markup. One linear pass over the input regardless
 *  of how many `</body>` tokens it contains. When `</body>` is missing
 *  (server-streamed HTML, partial output, hand-written fragment), `tag`
 *  is appended at the end so the script still loads. Empty input is
 *  returned untouched. */
export function injectBeforeBodyClose(html: string, tag: string): string {
  if (!html) return html;
  const matches = [...html.matchAll(BODY_CLOSE_RE)];
  const idx = matches[matches.length - 1]?.index;
  if (idx === undefined) return html + tag;
  return `${html.slice(0, idx)}${tag}${html.slice(idx)}`;
}
