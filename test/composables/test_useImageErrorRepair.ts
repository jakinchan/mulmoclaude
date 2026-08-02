import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  repairImageSrc,
  repairSourceSrc,
  IMAGE_REPAIR_PATTERN,
  IMAGE_REPAIR_PATTERN_ENCODED,
  IMAGE_REPAIR_INLINE_SCRIPT,
  findRepairTarget,
} from "../../src/composables/useImageErrorRepair.js";

// A tiny stand-in for HTMLImageElement — only the attributes the
// repair function reads/writes. Lets us exercise the pure function
// without a DOM.
interface FakeImg {
  src: string;
  dataset: { imageRepairTried?: string };
}

function makeImg(src: string): FakeImg {
  return { src, dataset: {} };
}

describe("repairImageSrc", () => {
  it("rewrites a wrong-prefix path that contains artifacts/images/<rest>", () => {
    const img = makeImg("http://localhost:5173/wrong/prefix/artifacts/images/2026/04/foo.png");
    const ok = repairImageSrc(img as unknown as HTMLImageElement);
    assert.equal(ok, true);
    assert.equal(img.src, "/artifacts/images/2026/04/foo.png");
    assert.equal(img.dataset.imageRepairTried, "1");
  });

  it("rewrites a relative path that contains the pattern", () => {
    const img = makeImg("../../../artifacts/images/2026/04/foo.png");
    const ok = repairImageSrc(img as unknown as HTMLImageElement);
    assert.equal(ok, true);
    assert.equal(img.src, "/artifacts/images/2026/04/foo.png");
  });

  it("leaves a src that doesn't contain the pattern alone", () => {
    const img = makeImg("/api/files/raw?path=data%2Fwiki%2Fsources%2Ffoo.png");
    const ok = repairImageSrc(img as unknown as HTMLImageElement);
    assert.equal(ok, false);
    assert.equal(img.src, "/api/files/raw?path=data%2Fwiki%2Fsources%2Ffoo.png");
    // The marker MUST NOT be set on a no-match: otherwise a later
    // repairable src on the same DOM element would be silently blocked.
    assert.equal(img.dataset.imageRepairTried, undefined);
  });

  it("a no-match call doesn't poison a later repairable src on the same element", () => {
    const img = makeImg("https://external.example.com/some.png");
    const first = repairImageSrc(img as unknown as HTMLImageElement);
    assert.equal(first, false);
    // Same DOM node, src now matches.
    img.src = "/wrong/prefix/artifacts/images/foo.png";
    const second = repairImageSrc(img as unknown as HTMLImageElement);
    assert.equal(second, true);
    assert.equal(img.src, "/artifacts/images/foo.png");
  });

  it("does not retry a second time once tried", () => {
    const img = makeImg("/wrong/artifacts/images/foo.png");
    const first = repairImageSrc(img as unknown as HTMLImageElement);
    assert.equal(first, true);
    assert.equal(img.src, "/artifacts/images/foo.png");
    // Simulate a second 404 — the flag should block the retry.
    img.src = "/still/wrong/artifacts/images/foo.png";
    const second = repairImageSrc(img as unknown as HTMLImageElement);
    assert.equal(second, false);
    assert.equal(img.src, "/still/wrong/artifacts/images/foo.png");
  });

  it("interpolates the same regex literal into the inline script", () => {
    // The inline script must reference the literal form of
    // `IMAGE_REPAIR_PATTERN` — not a hand-typed copy. If someone
    // edits the regex on the TS side and forgets the script string,
    // this test catches the drift via substring presence.
    assert.equal(IMAGE_REPAIR_PATTERN.source, "artifacts\\/images\\/.+");
    assert.ok(IMAGE_REPAIR_INLINE_SCRIPT.includes(IMAGE_REPAIR_PATTERN.toString()), "inline script must embed `IMAGE_REPAIR_PATTERN.toString()` verbatim");
    // Encoded pattern + decode call must also be embedded so iframe
    // surfaces (presentHtml) get the same broken-prefix-via-rewriter
    // recovery the host shell does (#1102 / L-W-S-04).
    assert.ok(
      IMAGE_REPAIR_INLINE_SCRIPT.includes(IMAGE_REPAIR_PATTERN_ENCODED.toString()),
      "inline script must embed `IMAGE_REPAIR_PATTERN_ENCODED.toString()` verbatim",
    );
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /decodeURIComponent/);
  });

  it("rewrites a percent-encoded artifacts/images segment from the markdown rewriter (issue #1102)", () => {
    // The wiki / markdown rewriter routes
    //   <img src="/wrong/prefix/artifacts/images/foo.png">
    // through `/api/files/raw?path=...`, which percent-encodes the
    // slashes — so the rendered `img.src` carries
    //   .../api/files/raw?path=wrong%2Fprefix%2Fartifacts%2Fimages%2Ffoo.png
    // The unencoded pattern can't see that, so the repair must fall
    // through to the encoded pattern + decode the captured tail
    // before retrying.
    const img = makeImg("http://localhost:5173/api/files/raw?path=wrong%2Fprefix%2Fartifacts%2Fimages%2Flws04-debug.png");
    const ok = repairImageSrc(img as unknown as HTMLImageElement);
    assert.equal(ok, true);
    assert.equal(img.src, "/artifacts/images/lws04-debug.png");
    assert.equal(img.dataset.imageRepairTried, "1");
  });

  it("stops the encoded match at a `&v=` cache-bust separator", () => {
    // `resolveImageSrcFresh` appends `&v=<bump>` to the API URL. The
    // encoded path tail must NOT swallow the suffix into the
    // captured filename, otherwise the repaired URL would be
    //   /artifacts/images/foo.png&v=N
    // which misses the static-mount file.
    const img = makeImg("http://localhost:5173/api/files/raw?path=foo%2Fartifacts%2Fimages%2Fbar.png&v=42");
    const ok = repairImageSrc(img as unknown as HTMLImageElement);
    assert.equal(ok, true);
    assert.equal(img.src, "/artifacts/images/bar.png");
  });

  it("encoded match also respects the one-shot retry guard", () => {
    const img = makeImg("/api/files/raw?path=wrong%2Fartifacts%2Fimages%2Ffoo.png");
    assert.equal(repairImageSrc(img as unknown as HTMLImageElement), true);
    assert.equal(img.src, "/artifacts/images/foo.png");
    // Second 404 on the same DOM node — the one-shot marker blocks it.
    img.src = "/api/files/raw?path=still%2Fartifacts%2Fimages%2Ffoo.png";
    assert.equal(repairImageSrc(img as unknown as HTMLImageElement), false);
    assert.equal(img.src, "/api/files/raw?path=still%2Fartifacts%2Fimages%2Ffoo.png");
  });

  it("prefers the unencoded match when both forms are present in the URL", () => {
    // Pathological: an unencoded path tail with an unrelated encoded
    // segment elsewhere. The repair must use the unencoded match
    // (Stage 3 historical behaviour), not the encoded fallback.
    const img = makeImg("/wrong/artifacts/images/foo.png?meta=x%2Fartifacts%2Fimages%2Fbar");
    const ok = repairImageSrc(img as unknown as HTMLImageElement);
    assert.equal(ok, true);
    // `.+` is greedy across the whole tail; this is the existing
    // Stage 3 contract — the repair would target the static mount
    // and fail again if a real `?meta` survived, but the one-shot
    // guard prevents an infinite loop.
    assert.ok(img.src.startsWith("/artifacts/images/foo.png"));
  });
});

describe("findRepairTarget", () => {
  it("returns the unencoded tail for a URL that already carries plain slashes", () => {
    // Direct happy path covering the unencoded branch on its own,
    // independent of `repairImageSrc` (which exercises this helper
    // indirectly). Lets future refactors of the helper land without
    // having to read the indirect path coverage.
    const target = findRepairTarget("/wrong/prefix/artifacts/images/foo.png");
    assert.equal(target, "artifacts/images/foo.png");
  });

  it("decodes a percent-encoded tail that the wiki rewriter produced", () => {
    // Direct happy path for the encoded branch — same shape the wiki
    // rewriter emits when it routes a broken-prefix absolute path
    // through `/api/files/raw?path=...`.
    const target = findRepairTarget("/api/files/raw?path=wrong%2Fprefix%2Fartifacts%2Fimages%2Ffoo.png");
    assert.equal(target, "artifacts/images/foo.png");
  });

  it("returns null on a malformed percent-encoded tail (decodeURIComponent throws)", () => {
    // `%E0%A4` is an incomplete UTF-8 sequence — decodeURIComponent
    // throws `URIError`. Repair must treat it as a no-op rather than
    // letting the exception escape into the document `error` handler.
    const target = findRepairTarget("/api/files/raw?path=foo%2Fartifacts%2Fimages%2F%E0%A4");
    assert.equal(target, null);
  });

  it("returns null on a URL that carries neither artifacts/images form", () => {
    assert.equal(findRepairTarget("https://example.com/foo.png"), null);
    assert.equal(findRepairTarget("/api/files/raw?path=data%2Fwiki%2Fsources%2Ffoo.png"), null);
  });
});

// Stand-in for HTMLSourceElement covering only what `repairSourceSrc`
// reads/writes. `getAttribute` / `setAttribute` mock keeps the test
// in the same plain-JS shape as the <img> stand-in above.
interface FakeSource {
  srcset?: string | undefined;
  attrs: Record<string, string>;
  dataset: { imageRepairTried?: string };
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
}

function makeSource(opts: { srcset?: string | undefined; src?: string | undefined } = {}): FakeSource {
  const attrs: Record<string, string> = {};
  if (opts.src !== undefined) attrs.src = opts.src;
  return {
    srcset: opts.srcset,
    attrs,
    dataset: {},
    getAttribute(name) {
      if (!Object.prototype.hasOwnProperty.call(attrs, name)) return null;
      const value = attrs[name];
      return value === undefined ? null : value;
    },
    setAttribute(name, value) {
      attrs[name] = value;
    },
  };
}

describe("repairSourceSrc", () => {
  it("rewrites a wrong-prefix `src` attribute (audio/video <source> shape)", () => {
    const source = makeSource({ src: "/wrong/prefix/artifacts/images/foo.png" });
    const ok = repairSourceSrc(source as unknown as HTMLSourceElement);
    assert.equal(ok, true);
    assert.equal(source.attrs.src, "/artifacts/images/foo.png");
    assert.equal(source.dataset.imageRepairTried, "1");
  });

  it("rewrites a wrong-prefix `srcset` attribute (picture <source> shape)", () => {
    const source = makeSource({ srcset: "../../../artifacts/images/foo.png" });
    const ok = repairSourceSrc(source as unknown as HTMLSourceElement);
    assert.equal(ok, true);
    assert.equal(source.srcset, "/artifacts/images/foo.png");
  });

  it("preserves srcset descriptors while repairing each URL token", () => {
    const source = makeSource({ srcset: "../wrong/artifacts/images/foo.png 1x, ../wrong/artifacts/images/foo@2x.png 2x" });
    const ok = repairSourceSrc(source as unknown as HTMLSourceElement);
    assert.equal(ok, true);
    assert.equal(source.srcset, "/artifacts/images/foo.png 1x, /artifacts/images/foo@2x.png 2x");
  });

  it("leaves a `srcset` token that does not match the pattern alone", () => {
    const source = makeSource({ srcset: "https://external.example.com/foo.png 1x" });
    const ok = repairSourceSrc(source as unknown as HTMLSourceElement);
    assert.equal(ok, false);
    assert.equal(source.srcset, "https://external.example.com/foo.png 1x");
    // No marker on a no-match — same invariant as repairImageSrc.
    assert.equal(source.dataset.imageRepairTried, undefined);
  });

  it("repairs both `src` and `srcset` in one call when both match", () => {
    const source = makeSource({
      src: "/wrong/prefix/artifacts/images/poster.png",
      srcset: "../wrong/artifacts/images/foo.png 1x",
    });
    const ok = repairSourceSrc(source as unknown as HTMLSourceElement);
    assert.equal(ok, true);
    assert.equal(source.attrs.src, "/artifacts/images/poster.png");
    assert.equal(source.srcset, "/artifacts/images/foo.png 1x");
  });

  it("does not retry once tried", () => {
    const source = makeSource({ srcset: "/wrong/artifacts/images/foo.png" });
    assert.equal(repairSourceSrc(source as unknown as HTMLSourceElement), true);
    source.srcset = "/still/wrong/artifacts/images/foo.png";
    assert.equal(repairSourceSrc(source as unknown as HTMLSourceElement), false);
    assert.equal(source.srcset, "/still/wrong/artifacts/images/foo.png");
  });

  it("treats a missing src and missing srcset as a no-op", () => {
    const source = makeSource();
    assert.equal(repairSourceSrc(source as unknown as HTMLSourceElement), false);
    assert.equal(source.dataset.imageRepairTried, undefined);
  });

  it("rewrites a percent-encoded `src` attribute (issue #1102 parity for <source>)", () => {
    const source = makeSource({ src: "/api/files/raw?path=wrong%2Fprefix%2Fartifacts%2Fimages%2Fposter.png" });
    const ok = repairSourceSrc(source as unknown as HTMLSourceElement);
    assert.equal(ok, true);
    assert.equal(source.attrs.src, "/artifacts/images/poster.png");
  });

  it("rewrites percent-encoded `srcset` tokens with descriptors preserved (issue #1102 parity for <picture>)", () => {
    // Picture-shape `<source srcset>`: each comma-list token may carry
    // the same wiki-rewriter percent-encoding as the `src` shape, plus
    // a trailing `1x` / `2x` / `100w` descriptor. The repair must
    // decode the encoded segment per token without disturbing the
    // descriptor.
    const source = makeSource({
      srcset: "/api/files/raw?path=wrong%2Fartifacts%2Fimages%2Ffoo.png 1x, /api/files/raw?path=wrong%2Fartifacts%2Fimages%2Ffoo%402x.png 2x",
    });
    const ok = repairSourceSrc(source as unknown as HTMLSourceElement);
    assert.equal(ok, true);
    assert.equal(source.srcset, "/artifacts/images/foo.png 1x, /artifacts/images/foo@2x.png 2x");
  });
});

describe("IMAGE_REPAIR_INLINE_SCRIPT — Stage E parity", () => {
  it("references all four tag-name branches the document listener handles", () => {
    // Drift guard: the iframe-inlined script must match the TS
    // dispatcher in `useGlobalImageErrorRepair`. If the TS gains a
    // new branch, the inline must too — otherwise iframe surfaces
    // (presentHtml etc) silently regress for that case.
    // Operator spacing varies by toolchain: tsc emits `tagName === "IMG"`
    // (with spaces), tsx/esbuild emits `tagName==="IMG"` (compact). Match
    // both. Behavior tests in `test/utils/image/test_imageRepairInlineScript.ts`
    // exercise each branch with real (mock) elements (#1244).
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /tagName\s*===\s*"IMG"/);
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /tagName\s*===\s*"SOURCE"/);
    // <audio>/<video> propagate child-source errors up to themselves.
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /tagName\s*===\s*"AUDIO"/);
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /tagName\s*===\s*"VIDEO"/);
    // The picture-sibling walk must also be in lock step.
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /closest\("picture"\)/);
    // The audio/video child walk uses `:scope > source` to avoid
    // grabbing the inner <picture><source> case (which is already
    // handled by the IMG branch via `closest("picture")`).
    assert.match(IMAGE_REPAIR_INLINE_SCRIPT, /:scope > source/);
  });
});
