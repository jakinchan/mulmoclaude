// Source-editor bookmarks: the user marks places in a markdown document with a
// string of their own choosing (`...` on its own line, by default), and the
// editor puts a clickable marker for each one in a rail down its left edge, at
// that place's position in the document.
//
// What counts as a bookmark is a REGULAR EXPRESSION, configured once per
// machine in `~/.config/mulmo/config.json` (`documentBookmarks.pattern`) and
// shared by MulmoClaude and MulmoTerminal. The server reads and validates it
// (`@mulmoclaude/core/global-config`); this file is what the View compiles and
// runs, so it is browser-safe — pure string work, no node imports.

import { truncate } from "@mulmoclaude/core/utils";

/** Shipped default: `...` at the start of a line. Escaped, because the value is
 *  a regex source — a bare `^...` would mean "any three characters", which
 *  matches the start of nearly every line. Used when the config file is absent,
 *  has no usable pattern, or could not be reached at all. */
export const DEFAULT_DOCUMENT_BOOKMARK_PATTERN = "^\\.\\.\\.";

/** Ceiling on markers. A rail taller than the editor cannot show more than a
 *  few dozen distinguishable triangles anyway, and an over-broad pattern (`^`)
 *  would otherwise mean one DOM node per line of the document. */
export const MAX_DOCUMENT_BOOKMARKS = 200;

/** How much of the matched line the marker's tooltip carries. */
const BOOKMARK_LABEL_MAX = 80;

export interface DocumentBookmark {
  /** Character offset of the match start within the document. */
  readonly offset: number;
  /** Where it sits in the document, 0 (top) to 1 (bottom) — the rail's own
   *  coordinate, and what the click maps back onto the editor's scroll. */
  readonly fraction: number;
  /** The whole line the match starts on, trimmed and clipped — the tooltip. */
  readonly label: string;
}

/**
 * Compile a configured pattern source. Returns null when it does not compile,
 * so a bad pattern costs the user their markers and nothing else.
 *
 * `m` so `^` and `$` mean line boundaries rather than document boundaries —
 * without it the default `^\.\.\.` could only ever match the very first line.
 * `g` because the scan wants every match, not the first.
 */
export function compileBookmarkPattern(source: string): RegExp | null {
  try {
    return new RegExp(source, "gm");
  } catch {
    return null;
  }
}

/** The full line containing `offset`, trimmed and clipped for a tooltip. */
function lineAt(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const end = text.indexOf("\n", offset);
  return truncate(text.slice(start, end < 0 ? text.length : end).trim(), BOOKMARK_LABEL_MAX);
}

/**
 * Every place in `text` the pattern matches, in document order.
 *
 * Re-compiles the pattern per scan rather than reusing the caller's object: a
 * `g` regex carries mutable `lastIndex`, so a shared instance would resume mid
 * document on the next keystroke and silently drop the markers above the cursor.
 */
export function findDocumentBookmarks(text: string, pattern: RegExp | null): DocumentBookmark[] {
  if (pattern === null || text.length === 0) return [];
  const scanner = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const found: DocumentBookmark[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    found.push({ offset: match.index, fraction: match.index / text.length, label: lineAt(text, match.index) });
    // A zero-length match (`^`, `(?=x)`, an all-optional pattern) leaves
    // `lastIndex` where it was, so `exec` would return the same match forever.
    // Stepping past it is the standard guard — and the reason this loop cannot
    // hang on a pattern the user typed.
    if (match.index === scanner.lastIndex) scanner.lastIndex += 1;
    if (found.length >= MAX_DOCUMENT_BOOKMARKS) break;
  }
  return found;
}
