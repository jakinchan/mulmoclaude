// Pure `[[wiki-link]]` → HTML renderer, shared across hosts via
// `@mulmoclaude/core/wiki`. Extracted from the MulmoClaude host's
// `src/plugins/wiki/helpers.ts` so MulmoTerminal can render the same
// internal-link markup without forking the walker.
//
// String-only, no `marked` / DOM / Node deps — the host pipeline
// (image-ref rewrite, marked.parse, task-interactive) wraps this.

import { escapeHtml } from "@mulmoclaude/common";
import { parseWikiLink, WIKI_LINK_MAX_LEN } from "./link.js";

// `escapeHtml` moved down to the zero-dep leaf `@mulmoclaude/common` (#2483) so
// `@mulmoclaude/markdown-utils` — a leaf THIS package depends on, hence unable
// to import back up — can share it. Re-exported here because the wiki
// consumers (collection-plugin's graph view, the host's wiki embeds and
// spreadsheet view) already import it from `@mulmoclaude/core/wiki`.
export { escapeHtml };

/**
 * Replace every `[[page name]]` occurrence in `content` with a
 * `<span class="wiki-link" data-page="…">…</span>` element. The
 * page name may not contain `[` or `]`; an opening `[[` that is
 * not followed later by `]]` (with no bare `[` or `]` in between)
 * is left untouched so malformed text renders as-is — matching the
 * previous regex's non-match behaviour.
 *
 * `[[target|display]]` is split via the shared `parseWikiLink`
 * helper so `data-page` carries only the target slug while the
 * visible text shows the display half (#1297). Both halves are
 * HTML-escaped before interpolation — `parseWikiLink` runs BEFORE
 * the host's `marked.parse`, so escaping has to happen here.
 */
export function renderWikiLinks(content: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] === "[" && content[i + 1] === "[") {
      const closeStart = findNextCloseBrackets(content, i + 2);
      if (closeStart !== -1) {
        const inner = content.slice(i + 2, closeStart);
        const { target, display } = parseWikiLink(inner);
        out.push(`<span class="wiki-link" data-page="${escapeHtml(target)}">${escapeHtml(display)}</span>`);
        i = closeStart + 2;
        continue;
      }
    }
    out.push(content.charAt(i));
    i++;
  }
  return out.join("");
}

/**
 * Starting at `from`, scan forward for a `]]` sequence. Returns
 * the index of the first `]` of that pair, or -1 if the span isn't
 * a valid wiki-link body — mirroring `WIKI_LINK_PATTERN` exactly so
 * the renderer can't accept a link the graph / backlinks / lint
 * would reject. The pattern's body class is `[^\][\r\n]`, so it
 * rejects `[` as well as `]`. Bails (-1) on:
 *   - a bare `]` (regex `[^\]]`),
 *   - a `[` inside the body (regex `[^\[]` — a nested `[[` opener
 *     never belongs in a page name, and the pattern would not match),
 *   - a `\r` or `\n` (regex `[^\r\n]` — a newline-bearing link must
 *     not render clickable, and its slug must not reach the URL),
 *   - a body longer than WIKI_LINK_MAX_LEN (regex `{1,200}`),
 *   - a zero-length body (regex `{1,}` minimum),
 *   - reaching end-of-input with no `]]`.
 */
function findNextCloseBrackets(str: string, from: number): number {
  let j = from;
  while (j < str.length) {
    const char = str[j];
    if (char === "]") {
      if (str[j + 1] === "]" && j > from) return j;
      // Bare `]` inside the page-name span — regex would not match.
      return -1;
    }
    // A `[`, a newline, or a span past the cap: none match the pattern's
    // `[^\][\r\n]{1,200}` body, so bail and let the caller emit `[[` literally.
    if (char === "[" || char === "\n" || char === "\r" || j - from >= WIKI_LINK_MAX_LEN) return -1;
    j++;
  }
  return -1;
}
