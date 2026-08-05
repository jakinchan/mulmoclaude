// Where a character offset actually SITS in a textarea, in pixels.
//
// The rail needs this twice over: to place each marker at its bookmark's
// position in the document, and to scroll the editor to that exact place when
// the marker is clicked. Both were first derived from the character offset as a
// fraction of the document length — cheap, and wrong: a blank line, a heading
// and a wrapped paragraph carry wildly different numbers of characters per line
// of height, so a fraction of the TEXT is not a fraction of the HEIGHT. In a
// markdown document (short headings and blank lines early, long prose later)
// that error is systematic, not noise, and a click overshot the bookmark.
//
// So measure instead of estimating. A hidden div is laid out with the same box
// and the same typography as the textarea, and each offset is wrapped around
// the single character at it — one existing character moved into a `<span>`
// changes nothing about the layout, and `offsetTop` then reports where the
// browser really put that line, wrapping included.
//
// Browser-only (touches the DOM), so it lives beside the View rather than in
// the pure `./bookmarks` scanner.

/** Textarea properties the mirror must copy for its line breaking and line
 *  heights to match. Width comes from `clientWidth` (below), not from here —
 *  the textarea's own `width` may be a flex-resolved `auto`, and the border is
 *  zeroed there rather than copied. */
const MIRRORED_STYLE_PROPERTIES = [
  "boxSizing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "tabSize",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
] as const;

export interface BookmarkGeometry {
  /** Pixel offset of each requested character offset from the top of the
   *  textarea's scrollable content — i.e. the `scrollTop` that brings that
   *  place to the top of the visible box. Same order as the input. */
  readonly tops: readonly number[];
  /** Full height of the laid-out content, the 100% the rail divides. */
  readonly contentHeight: number;
}

function buildMirror(textarea: HTMLTextAreaElement): HTMLDivElement {
  const mirror = document.createElement("div");
  const computed = window.getComputedStyle(textarea);
  for (const property of MIRRORED_STYLE_PROPERTIES) {
    mirror.style[property] = computed[property];
  }
  // `clientWidth` is the content box plus padding — the width the text is
  // actually broken against, whatever resolved the textarea's own `width`.
  // `border-box` against `clientWidth` (which already excludes the border) with
  // no border of its own: the content width then matches the textarea's exactly,
  // so the two break their lines in the same places.
  mirror.style.boxSizing = "border-box";
  mirror.style.borderWidth = "0";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = "auto";
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.overflow = "hidden";
  mirror.style.pointerEvents = "none";
  // A textarea never collapses its trailing whitespace or its blank lines, and
  // it breaks long words rather than overflowing. The computed values above
  // usually carry this already; restating it keeps a host stylesheet from
  // quietly changing the line count.
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  return mirror;
}

/**
 * Fill `mirror` with `text`, wrapping the ONE character at each offset in a
 * span so its position can be read back. Returns the spans in input order.
 *
 * Offsets are visited in ascending order (the scanner already yields them that
 * way) so the text can be appended in a single forward pass.
 */
function markOffsets(mirror: HTMLDivElement, text: string, offsets: readonly number[]): HTMLSpanElement[] {
  const spans: HTMLSpanElement[] = [];
  let cursor = 0;
  for (const offset of offsets) {
    const clamped = Math.max(cursor, Math.min(offset, text.length));
    mirror.appendChild(document.createTextNode(text.slice(cursor, clamped)));
    const span = document.createElement("span");
    // Past the end of the text there is no character to wrap; a zero-width
    // space stands in for one so the span still has a position.
    span.textContent = clamped < text.length ? text[clamped]! : "​";
    mirror.appendChild(span);
    spans.push(span);
    cursor = clamped + 1;
  }
  mirror.appendChild(document.createTextNode(text.slice(Math.min(cursor, text.length))));
  return spans;
}

/**
 * Measure where each offset sits inside `textarea`'s content.
 *
 * Returns null when there is nothing to measure — no offsets, or a textarea
 * with no laid-out width (not yet mounted / display:none) — so the caller can
 * keep whatever positions it already had rather than snapping them all to zero.
 */
export function measureOffsetTops(textarea: HTMLTextAreaElement, text: string, offsets: readonly number[]): BookmarkGeometry | null {
  if (offsets.length === 0 || textarea.clientWidth === 0) return null;
  const mirror = buildMirror(textarea);
  const spans = markOffsets(mirror, text, offsets);
  // Appended to the textarea's own parent, not to <body>: inside MulmoTerminal
  // this View is mounted in a shadow root, and a mirror in the light DOM would
  // be laid out with none of the styles that decide where the text breaks.
  const host = textarea.parentElement ?? document.body;
  host.appendChild(mirror);
  try {
    return {
      tops: spans.map((span) => span.offsetTop),
      contentHeight: mirror.scrollHeight,
    };
  } finally {
    mirror.remove();
  }
}
