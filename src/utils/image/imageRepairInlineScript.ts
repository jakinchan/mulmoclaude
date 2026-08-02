import { injectBeforeBodyClose } from "../html/injectBeforeBodyClose";

// Inline-script flavour of the image-self-repair behaviour the app
// shell already runs via `useGlobalImageErrorRepair` (see
// `src/composables/useImageErrorRepair.ts`).
//
// Iframe surfaces (presentHtml result, Files HTML preview) live in
// their own Document, so the parent's document-level error handler
// can't see their `<img>` 404s. Server-side `inlineImages` (PDF) and
// the markdown rewriter (browser) cover the deterministic-resolution
// half of the routing strategy, but iframes that load HTML files
// directly off `/artifacts/html/...` need a third leg: an in-iframe
// `error` listener that does the same one-shot repair.
//
// This module is the **pure** form (no Vue, no DOM access at module
// load) so:
//   - server/index.ts can import it for splicing into HTML responses
//   - the composable in `useImageErrorRepair.ts` re-exports it for
//     back-compat with existing test imports
//
// Stage 3 of the image-path-routing redesign — see
// plans/done/feat-image-path-routing.md and #1025.

// All Gemini / canvas / image-edit output lives at
// `artifacts/images/YYYY/MM/<id>.png` (server/utils/files/image-store.ts).
// If a rendered URL embeds that segment somewhere, trim everything
// before the pattern and retry as `/artifacts/images/<rest>` — the
// static mount will then serve the file directly.
export const IMAGE_REPAIR_PATTERN = /artifacts\/images\/.+/;

// Same segment in percent-encoded form. The wiki / markdown rewriter
// routes an unrecognised absolute path like `/wrong/prefix/artifacts/
// images/foo.png` through `/api/files/raw?path=...` (see
// `rewriteMarkdownImageRefs.ts` / `resolveImageSrc`), which encodes
// the slashes — so the rendered `img.src` carries
// `artifacts%2Fimages%2Ffoo.png`, not the unencoded form. The pattern
// above can't see through that, so a 404 that's actually salvageable
// silently misses (issue #1102 / e2e-live L-W-S-04). The
// `[^&#\s]` class stops the greedy match at a query-string separator
// (`&`), a fragment (`#`) or whitespace, so a trailing `&v=<bump>`
// from `resolveImageSrcFresh` doesn't get swallowed into the captured
// path tail.
//
// Contract assumption: any in-app producer that may end up downstream
// of this match uses `&` to start additional query params (the
// `resolveImageSrc` / `resolveImageSrcFresh` pair is the only one
// today). The class deliberately does NOT include `?` or `;` because
// neither appears as a separator after `?path=...` in an in-app URL —
// `?` only appears once at the start of the query string (already
// before our match), and `;` is not used. If a future producer
// switches to a `;`-list or emits a second `?`, this class will
// over-consume; bound the match here in lockstep with that producer.
export const IMAGE_REPAIR_PATTERN_ENCODED = /artifacts%2[Ff]images%2[Ff][^&#\s]+/;

/** Pull the `artifacts/images/<rest>` substring out of a rendered
 *  `<img>` / `<source>` URL, in either unencoded form or the
 *  percent-encoded form the markdown rewriter produces.
 *
 *  Returns the raw (decoded) path tail without a leading `/`, so the
 *  caller writes `/${target}` to the element. Returns `null` when the
 *  URL doesn't carry a recognised artifacts/images segment, or when
 *  the encoded match can't be `decodeURIComponent`-d (malformed input
 *  is treated as a no-op rather than throwing into the error handler).
 *
 *  Unencoded match wins over the encoded one — matches the historical
 *  Stage 3 behaviour for any URL that already carries plain slashes
 *  (relative refs, broken-prefix raw absolute, etc.). */
export function findRepairTarget(src: string): string | null {
  const direct = src.match(IMAGE_REPAIR_PATTERN);
  if (direct) return direct[0];
  const encoded = src.match(IMAGE_REPAIR_PATTERN_ENCODED);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded[0]);
  } catch {
    return null;
  }
}

/** The actual repair logic, written as a real TypeScript function so
 *  ESLint, typecheck, and unit tests apply to it directly (#1244).
 *  The inline-script form below is built by stringifying this function
 *  and invoking it from inside an `addEventListener("error", ...)`
 *  installed in the iframe's null-origin scope.
 *
 *  Pure: takes the event target + both regex patterns as arguments,
 *  closes over no module-scope identifiers, so `Function.toString()`
 *  produces a self-contained body that runs unchanged in the iframe.
 *
 *  The shapes used inside (`dataset`, `src`, `closest`,
 *  `querySelectorAll`) are described by the duck type `ElLike` below,
 *  which real `HTMLImageElement` / `HTMLSourceElement` satisfy and a
 *  plain test object can too — so the same body works in any iframe
 *  context without assuming a particular DOM implementation. */
// Duck-typed element shape the repair logic touches. Real `Element` /
// `HTMLImageElement` / `HTMLSourceElement` etc. all satisfy this; tests
// pass a plain object that does too.
interface ElLike {
  tagName: string;
  dataset: { imageRepairTried?: string };
  src?: string | undefined;
  srcset?: string | undefined;
  getAttribute?: ((name: string) => string | null) | undefined;
  setAttribute?: ((name: string, value: string) => void) | undefined;
  closest?: ((selector: string) => ElLike | null) | undefined;
  querySelectorAll?: ((selector: string) => Iterable<ElLike>) | undefined;
}

// Runtime resolver: pull the artifacts/images path tail out of either
// the unencoded or percent-encoded URL form. Mirrors `findRepairTarget`
// (which the host shell composable uses) but without depending on
// module-scope identifiers — both forms have to round-trip through
// `Function.toString()` into the iframe scope, so each takes the
// patterns by argument.
function findInlineRepairMatch(input: string, pattern: RegExp, patternEncoded: RegExp): string | null {
  const direct = input.match(pattern);
  if (direct) return direct[0];
  const enc = input.match(patternEncoded);
  if (!enc) return null;
  try {
    return decodeURIComponent(enc[0]);
  } catch {
    return null;
  }
}

// One-shot rewrite of an `<img>` element. Marks `dataset.imageRepairTried`
// before mutating so a second error event on the same element is a no-op.
function repairImg(img: ElLike, pattern: RegExp, patternEncoded: RegExp): void {
  if (img.dataset.imageRepairTried) return;
  const match = findInlineRepairMatch(String(img.src ?? ""), pattern, patternEncoded);
  if (!match) return;
  img.dataset.imageRepairTried = "1";
  img.src = `/${match}`;
}

// One-shot rewrite of a `<source>` element. Both `src` (via
// getAttribute / setAttribute, since `<source>.src` doesn't behave like
// `<img>.src`) and `srcset` get the same path-extraction treatment.
function repairSource(src: ElLike, pattern: RegExp, patternEncoded: RegExp): void {
  if (src.dataset.imageRepairTried) return;
  let changed = false;
  const srcAttr = src.getAttribute ? src.getAttribute("src") : null;
  if (srcAttr) {
    const match = findInlineRepairMatch(srcAttr, pattern, patternEncoded);
    if (match && src.setAttribute) {
      src.setAttribute("src", `/${match}`);
      changed = true;
    }
  }
  if (src.srcset) {
    const orig = src.srcset;
    const next = orig.replace(/[^\s,]+/g, (token) => {
      const match = findInlineRepairMatch(token, pattern, patternEncoded);
      return match ? `/${match}` : token;
    });
    if (next !== orig) {
      src.srcset = next;
      changed = true;
    }
  }
  if (changed) src.dataset.imageRepairTried = "1";
}

// Public entry point: dispatch by tagName onto the right helper.
// Pure (no module-scope closures); patterns come in by argument so the
// stringified form runs unchanged inside the iframe's null-origin scope.
// Declared against `ElLike`, not `EventTarget`: the only untyped caller is the
// installer inside `IMAGE_REPAIR_INLINE_SCRIPT`, which is a template string the
// compiler never sees, so typing this as `EventTarget` bought nothing and forced
// every typed caller to coerce an element-shaped value into `EventTarget` and
// back out again. A `target` that turns out not to be element-like simply fails
// the `tagName` comparisons below and falls through.
export function repairImageErrorTarget(target: ElLike | null, pattern: RegExp, patternEncoded: RegExp): void {
  if (!target) return;
  if (target.tagName === "IMG") {
    repairImg(target, pattern, patternEncoded);
    const pic = target.closest ? target.closest("picture") : null;
    if (pic && pic.querySelectorAll) {
      for (const source of pic.querySelectorAll("source")) repairSource(source, pattern, patternEncoded);
    }
    return;
  }
  if (target.tagName === "SOURCE") {
    repairSource(target, pattern, patternEncoded);
    return;
  }
  if ((target.tagName === "AUDIO" || target.tagName === "VIDEO") && target.querySelectorAll) {
    for (const source of target.querySelectorAll(":scope > source")) repairSource(source, pattern, patternEncoded);
  }
}

// Inline script intended for iframe surfaces. The body is the
// stringified `repairImageErrorTarget` plus a small installer that
// binds the (module-scope) regex patterns and forwards each `error`
// event's `target` into it. Same decision tree as
// `useGlobalImageErrorRepair`. The regex literals are interpolated
// from the exported patterns so the two stay in lockstep automatically.
//
// Why this shape (#1244): keeping the repair logic as a TypeScript
// function lets ESLint, typecheck, and direct-call unit tests cover
// it. `Function.toString()` returns the post-tsc JS, which round-trips
// faithfully under our `target: ES2022` setting (no down-leveling of
// `for`-loops, function declarations, or arrow functions).
//
// `__name` no-op stub: esbuild / tsx with `keepNames: true` (the
// default in `tsx` dev runs) emits `__name(fn, "fn")` calls after
// every named inner-function declaration to preserve `Function.name`
// for stack traces. Those references are inert in production Vite
// builds (where `__name` is hoisted to a module-level helper or
// elided), but the iframe's null-origin scope sees the toString
// output verbatim — so we MUST provide a definition or the iframe
// crashes on first error event. Defining it as a passthrough in the
// IIFE wrapper makes the script work in both dev and prod toolchains
// without depending on which compiler emitted the body.
export const IMAGE_REPAIR_INLINE_SCRIPT = [
  "(function () {",
  "  function __name(fn) { return fn; }",
  // Hoist each helper into the IIFE scope so the dispatcher's
  // `findInlineRepairMatch` / `repairImg` / `repairSource` references
  // resolve. Each `.toString()` is self-contained (no closures over
  // module-scope identifiers); the dispatcher then references them
  // by name within the same scope.
  `  ${findInlineRepairMatch.toString()}`,
  `  ${repairImg.toString()}`,
  `  ${repairSource.toString()}`,
  `  var handler = ${repairImageErrorTarget.toString()};`,
  '  document.addEventListener("error", function (event) {',
  `    handler(event.target, ${IMAGE_REPAIR_PATTERN.toString()}, ${IMAGE_REPAIR_PATTERN_ENCODED.toString()});`,
  "  }, true);",
  "})();",
].join("\n");

// Wrap the script body in a `<script>` tag once at module load; the
// splicer below uses this directly so each splice is a single string
// concatenation, not a per-request `<script>...</script>` rebuild.
const IMAGE_REPAIR_SCRIPT_TAG = `<script>${IMAGE_REPAIR_INLINE_SCRIPT}</script>`;

// `</body>` (case-insensitive, whitespace-tolerant). The previous
// implementation paired this with a `(?![\s\S]*<\/body\s*>)` negative
// lookahead to anchor at the LAST occurrence — but that lookahead is
// O(N²) on inputs with many `</body>` tokens (an adversarial / unusual
// input shape, but cheap to defang). `injectBeforeBodyClose` runs
// `matchAll` once over the input (linear) and takes the last hit, so
// the splice point selection is O(N) regardless of input shape.

/** Splice `<script>${IMAGE_REPAIR_INLINE_SCRIPT}</script>` into an
 *  HTML document just before its **last** closing `</body>`.
 *  Anchoring at the last close means nested `</body>` inside e.g.
 *  literal example text inside `<pre>` doesn't fool us into splicing
 *  too early. If the document has no `</body>` (fragments, hand-
 *  written HTML), append the tag at the end so the script still
 *  loads.
 *
 *  Pure string operation — safe to call on any HTML payload, no
 *  DOM parsing, no allocation beyond the result string. Linear time
 *  in input length even on adversarial inputs (verified by the
 *  `processes 100K </body> tokens in linear time` test). Idempotent:
 *  calling on already-spliced output appends a second copy (the
 *  script is one-shot per element so duplicates are harmless), so
 *  callers should splice exactly once per response. */
export function injectImageRepairScript(html: string): string {
  return injectBeforeBodyClose(html, IMAGE_REPAIR_SCRIPT_TAG);
}
