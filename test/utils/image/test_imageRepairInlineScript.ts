import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_REPAIR_INLINE_SCRIPT,
  IMAGE_REPAIR_PATTERN,
  IMAGE_REPAIR_PATTERN_ENCODED,
  injectImageRepairScript,
  repairImageErrorTarget,
} from "../../../src/utils/image/imageRepairInlineScript.js";

// ---------------------------------------------------------------------------
// Mock element shape — matches the duck-typed surface the inline script
// touches. Lets us drive the handler without a DOM.
// ---------------------------------------------------------------------------
interface MockElement {
  tagName: string;
  dataset: { imageRepairTried?: string };
  src?: string;
  srcset?: string;
  attrs: Record<string, string | undefined>;
  children: MockElement[]; // simple "shadow tree" for the picture/audio/video case
  parentPicture?: MockElement;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  closest: (selector: string) => MockElement | null;
  querySelectorAll: (selector: string) => MockElement[];
}

function makeElement(tagName: string, init: Partial<MockElement> = {}): MockElement {
  const attrs: Record<string, string | undefined> = init.attrs ?? {};
  const children: MockElement[] = init.children ?? [];
  const element: MockElement = {
    tagName,
    dataset: init.dataset ?? {},
    src: init.src,
    srcset: init.srcset,
    attrs,
    children,
    parentPicture: init.parentPicture,
    getAttribute(name: string) {
      // For SOURCE elements the inline script reads via getAttribute("src")
      // — mirror that, falling back to the typed `src` slot for completeness.
      if (name === "src") return attrs.src ?? this.src ?? null;
      return attrs[name] ?? null;
    },
    setAttribute(name: string, value: string) {
      attrs[name] = value;
      if (name === "src") this.src = value;
    },
    closest(selector: string) {
      if (selector === "picture") return this.parentPicture ?? null;
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "source") return this.children.filter((child) => child.tagName === "SOURCE");
      if (selector === ":scope > source") return this.children.filter((child) => child.tagName === "SOURCE");
      return [];
    },
  };
  return element;
}

describe("IMAGE_REPAIR_INLINE_SCRIPT — pure form", () => {
  it("embeds IMAGE_REPAIR_PATTERN.toString() verbatim so the two stay in lockstep", () => {
    assert.ok(IMAGE_REPAIR_INLINE_SCRIPT.includes(IMAGE_REPAIR_PATTERN.toString()));
  });

  it("embeds the encoded-form pattern + decodeURIComponent call (issue #1102)", () => {
    // Iframe surfaces (presentHtml) need the same broken-prefix-via-
    // rewriter recovery the host shell does. If someone bumps the
    // encoded regex without touching the inline script, this catches
    // the drift.
    assert.ok(IMAGE_REPAIR_INLINE_SCRIPT.includes(IMAGE_REPAIR_PATTERN_ENCODED.toString()));
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /decodeURIComponent/);
  });

  it("references all four element kinds the document-scope handler covers", () => {
    // Operator spacing varies by toolchain (`tagName === "IMG"` from
    // tsc, `tagName==="IMG"` from tsx/esbuild's compact mode), so the
    // pattern accepts either. The runtime-behavior tests below cover
    // each branch on real values.
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /tagName\s*===\s*"IMG"/);
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /tagName\s*===\s*"SOURCE"/);
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /tagName\s*===\s*"AUDIO"/);
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /tagName\s*===\s*"VIDEO"/);
  });

  it("attaches in capture phase (error events don't bubble)", () => {
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /addEventListener\("error",[\s\S]*?true\)/);
  });
});

describe("injectImageRepairScript", () => {
  const SCRIPT_OPEN = "<script>";
  const SCRIPT_CLOSE = "</script>";

  it("splices the script tag immediately before </body>", () => {
    const out = injectImageRepairScript("<html><body><p>hi</p></body></html>");
    assert.match(out, /<\/p><script>[\s\S]+<\/script><\/body>/);
  });

  it("appends to the end when the document has no </body>", () => {
    const out = injectImageRepairScript("<p>fragment with no body close</p>");
    assert.ok(out.startsWith("<p>fragment with no body close</p>"));
    assert.ok(out.endsWith(SCRIPT_CLOSE));
    assert.ok(out.includes(SCRIPT_OPEN));
  });

  it("is case-insensitive on </BODY>", () => {
    const out = injectImageRepairScript("<HTML><BODY>x</BODY></HTML>");
    assert.match(out, /x<script>[\s\S]+<\/script><\/BODY>/);
  });

  it("tolerates whitespace inside the closing tag (`</body >`)", () => {
    const out = injectImageRepairScript("<body>x</body >");
    assert.match(out, /x<script>[\s\S]+<\/script><\/body >/);
  });

  it("anchors at the LAST </body> when multiple closings appear (e.g. literal in code/CDATA)", () => {
    // Two `</body>` tokens — the first appears inside a `<pre>` block
    // as an example. The splicer must place the script before the
    // OUTER (last) `</body>`, not the literal.
    const html = "<body><pre>example: &lt;/body&gt;</pre>actually </body>tail</body>";
    const out = injectImageRepairScript(html);
    // Find the last `</body>` in the output; verify the script
    // immediately precedes it.
    const lastClose = out.lastIndexOf("</body>");
    assert.ok(lastClose > 0);
    const beforeLast = out.slice(0, lastClose);
    assert.ok(beforeLast.endsWith(SCRIPT_CLOSE), "script must immediately precede the last </body>");
  });

  it("returns an empty string unchanged", () => {
    assert.equal(injectImageRepairScript(""), "");
  });

  it("does not modify HTML that doesn't trigger any of the patterns of interest", () => {
    // No </body>, no other anchor — script appended at end.
    const html = "<svg><rect /></svg>";
    const out = injectImageRepairScript(html);
    assert.ok(out.startsWith(html));
    assert.ok(out.endsWith(SCRIPT_CLOSE));
  });

  it("preserves all original characters around the splice point (only adds, never removes)", () => {
    // Confirm the splice is purely additive: removing the inserted
    // <script>…</script> from the output reconstructs the input
    // verbatim. This catches regressions where the splice would
    // accidentally swallow surrounding content.
    const html = "<html><body><div>content</div></body></html>";
    const out = injectImageRepairScript(html);
    const stripped = out.replace(/<script>[\s\S]+?<\/script>/, "");
    assert.equal(stripped, html);
  });

  it("processes a 100KB document in well under a second (no quadratic cost)", () => {
    const filler = "<p>x</p>".repeat(12500); // ~100KB
    const html = `<html><body>${filler}</body></html>`;
    const start = Date.now();
    const out = injectImageRepairScript(html);
    const elapsedMs = Date.now() - start;
    assert.ok(out.includes("<script>"));
    assert.ok(elapsedMs < 1000, `expected <1s, got ${elapsedMs}ms`);
  });

  it("handles 100K repeated </body> tokens in linear time (Codex iter-1 review)", () => {
    // The previous regex used a negative lookahead `(?![\s\S]*<\/body\s*>)`
    // to anchor at the last close, which is O(N²) on inputs with many
    // `</body>` tokens. The matchAll-based splice point selection is
    // O(N) regardless. Probe with 100K closes — should still finish
    // well under a second.
    const adversarial = `<body>${"</body>".repeat(100_000)}x`;
    const start = Date.now();
    const out = injectImageRepairScript(adversarial);
    const elapsedMs = Date.now() - start;
    assert.ok(out.includes("<script>"));
    // Splice must be before the LAST `</body>`, so the tail "x" stays
    // unchanged, and only the last close is preceded by a script tag.
    assert.ok(out.endsWith("</body>x"));
    assert.ok(elapsedMs < 1000, `expected <1s for 100K tokens, got ${elapsedMs}ms`);
  });
});

// ---------------------------------------------------------------------------
// Behavior tests for `repairImageErrorTarget` — drives the actual function
// with mock elements (no DOM / jsdom). Covers the same decision tree as the
// inline script body since the script body IS this function (#1244).
// ---------------------------------------------------------------------------
describe("repairImageErrorTarget — runtime behavior", () => {
  it("rewrites <img>.src when the URL carries a recognisable artifacts/images segment", () => {
    const img = makeElement("IMG", { src: "/wrong/prefix/artifacts/images/2026/05/foo.png" });
    repairImageErrorTarget(img, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);
    assert.equal(img.src, "/artifacts/images/2026/05/foo.png");
    assert.equal(img.dataset.imageRepairTried, "1");
  });

  it("rewrites the encoded form via decodeURIComponent (issue #1102)", () => {
    const img = makeElement("IMG", { src: "/api/files/raw?path=artifacts%2Fimages%2F2026%2F05%2Ffoo.png" });
    repairImageErrorTarget(img, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);
    assert.equal(img.src, "/artifacts/images/2026/05/foo.png");
  });

  it("is a one-shot per element — second invocation is a no-op", () => {
    const img = makeElement("IMG", { src: "/wrong/artifacts/images/foo.png" });
    repairImageErrorTarget(img, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);
    assert.equal(img.src, "/artifacts/images/foo.png");
    // Even if a follow-up rewrite would change the path again, the
    // dataset flag stops it.
    img.src = "/wrong/again/artifacts/images/bar.png";
    repairImageErrorTarget(img, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);
    assert.equal(img.src, "/wrong/again/artifacts/images/bar.png");
  });

  it("leaves <img>.src alone when no pattern matches", () => {
    const img = makeElement("IMG", { src: "/some/other/path.png" });
    repairImageErrorTarget(img, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);
    assert.equal(img.src, "/some/other/path.png");
    assert.equal(img.dataset.imageRepairTried, undefined);
  });

  it("returns no-op when target is null", () => {
    assert.doesNotThrow(() => repairImageErrorTarget(null, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED));
  });

  it("rewrites a <source> element via getAttribute / setAttribute", () => {
    const src = makeElement("SOURCE", { attrs: { src: "/wrong/artifacts/images/x.webp" } });
    repairImageErrorTarget(src, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);
    assert.equal(src.attrs.src, "/artifacts/images/x.webp");
    assert.equal(src.dataset.imageRepairTried, "1");
  });

  it("rewrites every srcset candidate independently", () => {
    const src = makeElement("SOURCE", {
      srcset: "/wrong/artifacts/images/a.png 1x, /wrong/artifacts/images/b.png 2x, /unrelated.png 3x",
    });
    repairImageErrorTarget(src, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);
    assert.equal(src.srcset, "/artifacts/images/a.png 1x, /artifacts/images/b.png 2x, /unrelated.png 3x");
    assert.equal(src.dataset.imageRepairTried, "1");
  });

  it("rewrites <picture> sibling <source>s when an <img> inside it errors", () => {
    const img = makeElement("IMG", { src: "/wrong/artifacts/images/main.png" });
    const sourceA = makeElement("SOURCE", { attrs: { src: "/wrong/artifacts/images/a.webp" } });
    const sourceB = makeElement("SOURCE", { attrs: { src: "/wrong/artifacts/images/b.avif" } });
    const picture = makeElement("PICTURE", { children: [sourceA, sourceB, img] });
    img.parentPicture = picture;

    repairImageErrorTarget(img, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);

    assert.equal(img.src, "/artifacts/images/main.png");
    assert.equal(sourceA.attrs.src, "/artifacts/images/a.webp");
    assert.equal(sourceB.attrs.src, "/artifacts/images/b.avif");
  });

  it("rewrites <source> children of <audio> / <video>", () => {
    const sourceA = makeElement("SOURCE", { attrs: { src: "/wrong/artifacts/images/a.mp3" } });
    const sourceB = makeElement("SOURCE", { attrs: { src: "/wrong/artifacts/images/b.ogg" } });
    const audio = makeElement("AUDIO", { children: [sourceA, sourceB] });

    repairImageErrorTarget(audio, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);

    assert.equal(sourceA.attrs.src, "/artifacts/images/a.mp3");
    assert.equal(sourceB.attrs.src, "/artifacts/images/b.ogg");
  });

  it("treats malformed percent-encoded input as no-op (decodeURIComponent throw is caught)", () => {
    // `%E0%A4` is an incomplete UTF-8 sequence — decodeURIComponent will
    // throw URIError. The handler must swallow that and leave src alone,
    // not crash the iframe.
    const img = makeElement("IMG", { src: "/api/files/raw?path=artifacts%2Fimages%2F%E0%A4" });
    repairImageErrorTarget(img, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);
    assert.equal(img.src, "/api/files/raw?path=artifacts%2Fimages%2F%E0%A4");
    assert.equal(img.dataset.imageRepairTried, undefined);
  });

  it("ignores tags outside the IMG/SOURCE/AUDIO/VIDEO whitelist", () => {
    const div = makeElement("DIV", { src: "/wrong/artifacts/images/foo.png" });
    repairImageErrorTarget(div, IMAGE_REPAIR_PATTERN, IMAGE_REPAIR_PATTERN_ENCODED);
    assert.equal(div.src, "/wrong/artifacts/images/foo.png");
    assert.equal(div.dataset.imageRepairTried, undefined);
  });
});
