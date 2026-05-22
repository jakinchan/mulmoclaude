import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyWorkspacePath, resolveWikiHref } from "../../../src/utils/path/workspaceLinkRouter.js";

describe("classifyWorkspacePath", () => {
  // ── Wiki page links ───────────────────────────────────────

  describe("wiki page links", () => {
    it("classifies data/wiki/pages/<slug>.md as wiki", () => {
      const result = classifyWorkspacePath("data/wiki/pages/my-page.md");
      assert.deepEqual(result, { kind: "wiki", slug: "my-page" });
    });

    it("classifies wiki/pages/<slug>.md (without data/ prefix) as wiki", () => {
      const result = classifyWorkspacePath("wiki/pages/my-page.md");
      assert.deepEqual(result, { kind: "wiki", slug: "my-page" });
    });

    it("extracts multi-segment slug correctly", () => {
      const result = classifyWorkspacePath("data/wiki/pages/some-long-slug-name.md");
      assert.deepEqual(result, { kind: "wiki", slug: "some-long-slug-name" });
    });

    it("does not classify wiki source files as wiki pages", () => {
      const result = classifyWorkspacePath("data/wiki/sources/my-source.md");
      assert.ok(result);
      assert.equal(result.kind, "file");
    });

    it("does not classify wiki index as wiki page", () => {
      const result = classifyWorkspacePath("data/wiki/index.md");
      assert.ok(result);
      assert.equal(result.kind, "file");
    });
  });

  // ── Session links ─────────────────────────────────────────

  describe("session links", () => {
    it("classifies conversations/chat/<id>.jsonl as session", () => {
      const result = classifyWorkspacePath("conversations/chat/abc-123.jsonl");
      assert.deepEqual(result, { kind: "session", sessionId: "abc-123" });
    });

    it("classifies uuid session id", () => {
      const result = classifyWorkspacePath("conversations/chat/550e8400-e29b-41d4-a716-446655440000.jsonl");
      assert.deepEqual(result, { kind: "session", sessionId: "550e8400-e29b-41d4-a716-446655440000" });
    });

    it("does not classify nested paths under chat/ as session", () => {
      const result = classifyWorkspacePath("conversations/chat/sub/dir.jsonl");
      assert.ok(result);
      assert.equal(result.kind, "file");
    });

    it("does not classify non-jsonl files as session", () => {
      const result = classifyWorkspacePath("conversations/chat/abc-123.txt");
      assert.ok(result);
      assert.equal(result.kind, "file");
    });
  });

  // ── File links ────────────────────────────────────────────

  describe("file links", () => {
    it("classifies generic data/ paths as file", () => {
      const result = classifyWorkspacePath("data/some/file.txt");
      assert.deepEqual(result, { kind: "file", path: "data/some/file.txt" });
    });

    it("classifies config paths as file", () => {
      const result = classifyWorkspacePath("config/settings.json");
      assert.deepEqual(result, { kind: "file", path: "config/settings.json" });
    });

    it("normalizes ./ in paths", () => {
      const result = classifyWorkspacePath("./data/wiki/sources/foo.md");
      assert.deepEqual(result, { kind: "file", path: "data/wiki/sources/foo.md" });
    });
  });

  // ── Percent-encoded hrefs ─────────────────────────────────
  // marked.parse encodes multi-byte chars in <a href>, so we receive
  // hrefs like "data/notes/%E3%83%86%E3%82%B9%E3%83%88...md".
  // We MUST decode once before handing the path to vue-router, or the
  // router's own encoding step turns "%E3..." into "%25E3..." (see
  // plans/done/fix-workspace-link-double-encoding.md).

  describe("percent-encoded hrefs (from marked.parse output)", () => {
    it("decodes percent-encoded multibyte file path", () => {
      // "テストファイル" (test file) — generic Japanese name picked
      // so the literal does not look like real user data. The
      // encoded form is what marked.parse() actually emits for a
      // markdown link to this filename.
      const encoded = "data/notes/%E3%83%86%E3%82%B9%E3%83%88%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.md";
      const result = classifyWorkspacePath(encoded);
      assert.deepEqual(result, {
        kind: "file",
        path: "data/notes/テストファイル.md",
      });
    });

    it("decodes percent-encoded wiki page slug", () => {
      const encoded = "data/wiki/pages/%E3%82%B5%E3%83%B3%E3%83%97%E3%83%AB.md";
      const result = classifyWorkspacePath(encoded);
      assert.deepEqual(result, { kind: "wiki", slug: "サンプル" });
    });

    it("preserves ASCII percent-encoded space as literal (%20 stays as %20)", () => {
      // ASCII percent encodings are preserved as literal characters so
      // that the plugin naming convention (data/plugins/%40<scope>%2F<name>/)
      // survives the click → router → file API round-trip (#1473).
      // marked.parse() does not emit %20 for hrefs containing literal
      // spaces, so this hand-encoded form is treated as an opaque file
      // name token.
      const result = classifyWorkspacePath("data/some/my%20file.txt");
      assert.deepEqual(result, { kind: "file", path: "data/some/my%20file.txt" });
    });

    it("falls back to raw href when decode throws on malformed percent sequence", () => {
      // `%E3%83` is a truncated UTF-8 sequence; decodeURIComponent throws
      // URIError. We must not crash — use the raw href so the link still
      // routes (Files view will surface its own 404 if the path is truly bad).
      const malformed = "data/notes/broken-%E3%83.md";
      const result = classifyWorkspacePath(malformed);
      assert.deepEqual(result, { kind: "file", path: "data/notes/broken-%E3%83.md" });
    });

    it("is idempotent for already-decoded multibyte paths", () => {
      const raw = "data/notes/テストファイル.md";
      const result = classifyWorkspacePath(raw);
      assert.deepEqual(result, { kind: "file", path: raw });
    });

    // ASCII percent encodings (%2F, %2E, %40, %20, %25, …) are
    // preserved as literal characters so the plugin naming convention
    // — which stores npm-scoped packages as single URL-encoded disk
    // directories (data/plugins/%40<scope>%2F<name>/) — survives the
    // click → router → file API round-trip. The tests below pin that
    // semantics. Decoding is restricted to multibyte (UTF-8 high-byte)
    // sequences emitted by marked.parse for non-ASCII characters.
    //
    // Traversal protection is still provided by normalizePath, which
    // matches the literal `..` token. Encoded `%2E%2E` is now kept as
    // an opaque filename token and never reaches the `..` collapse
    // path — that narrows the attack surface (no encoded-traversal
    // path possible) rather than widening it. The server's
    // resolveWithinRoot adds a separate defense layer regardless.

    it("preserves ASCII %2F as a literal segment character (plugin-scoped naming)", () => {
      // Plugin convention: data/plugins/%40<scope>%2F<name>/ is a
      // SINGLE directory whose name literally contains '%' '4' '0'
      // '%' '2' 'F' characters — not two nested directories.
      const result = classifyWorkspacePath("data/plugins/%40mulmoclaude%2Fworklog/committed/2026-05.jsonl");
      assert.deepEqual(result, {
        kind: "file",
        path: "data/plugins/%40mulmoclaude%2Fworklog/committed/2026-05.jsonl",
      });
    });

    it("preserves ASCII %2F as literal even for non-plugin hand-encoded inputs", () => {
      // Behaviour change from the previous decode-everything implementation:
      // a hand-encoded `foo%2Fbar.md` is now treated as a single literal
      // filename token. marked.parse() never emits %2F for legitimate
      // workspace links, so this only matters for synthetic inputs.
      const result = classifyWorkspacePath("data/some/foo%2Fbar.md");
      assert.deepEqual(result, { kind: "file", path: "data/some/foo%2Fbar.md" });
    });

    it("preserves ASCII %2E%2E as literal segment (encoded-traversal is inert)", () => {
      // Previously %2E%2E was decoded to `..` and then collapsed by
      // normalizePath. Now %2E%2E stays opaque, so the traversal never
      // happens at this layer. resolveWithinRoot on the server side
      // remains the authoritative defense if anyone ever tries to
      // exploit this surface.
      const result = classifyWorkspacePath("data/wiki/pages/%2E%2E/sources/foo.md");
      assert.deepEqual(result, {
        kind: "file",
        path: "data/wiki/pages/%2E%2E/sources/foo.md",
      });
    });

    it("rejects literal `..` traversal that escapes workspace root", () => {
      // Literal `..` (not %2E%2E) is still detected by normalizePath
      // and rejected — the traversal protection that mattered (raw
      // `..` segments) is unchanged.
      const result = classifyWorkspacePath("%2E%2E/%2E%2E/etc/passwd");
      assert.deepEqual(result, {
        kind: "file",
        path: "%2E%2E/%2E%2E/etc/passwd",
      });
    });

    it("decodes multibyte while preserving ASCII percent literals in the same path (#1473)", () => {
      // Plugin scope dir name stays opaque, but a Japanese filename
      // inside it gets decoded to its multibyte form so the file API
      // (which receives disk-literal multibyte names) resolves.
      const encoded = "data/plugins/%40mulmoclaude%2Fworklog/%E3%83%A1%E3%83%A2.md";
      const result = classifyWorkspacePath(encoded);
      assert.deepEqual(result, {
        kind: "file",
        path: "data/plugins/%40mulmoclaude%2Fworklog/メモ.md",
      });
    });
  });

  // ── Null returns (external / invalid) ─────────────────────

  describe("returns null for non-workspace links", () => {
    it("returns null for http URLs", () => {
      assert.equal(classifyWorkspacePath("https://example.com"), null);
    });

    it("returns null for http URLs", () => {
      assert.equal(classifyWorkspacePath("http://example.com/path"), null);
    });

    it("returns null for mailto links", () => {
      assert.equal(classifyWorkspacePath("mailto:user@example.com"), null);
    });

    it("returns null for anchor-only links", () => {
      assert.equal(classifyWorkspacePath("#section"), null);
    });

    it("returns null for empty string", () => {
      assert.equal(classifyWorkspacePath(""), null);
    });

    it("returns null for paths that escape the workspace root", () => {
      assert.equal(classifyWorkspacePath("../../../etc/passwd"), null);
    });

    it("returns null for single ../ that escapes root", () => {
      assert.equal(classifyWorkspacePath("../outside.md"), null);
    });
  });

  // ── Wiki relative path resolution ─────────────────────────
  // Wiki pages link to sources/sessions with relative paths like
  // `../sources/foo.md`. The wiki View prepends `data/wiki/pages/`
  // before calling classifyWorkspacePath so that `../` segments
  // resolve correctly against the wiki page's filesystem location.

  describe("wiki relative paths (pre-resolved with data/wiki/pages/ prefix)", () => {
    it("resolves ../sources/<name>.md to a file", () => {
      const resolved = "data/wiki/pages/../sources/my-source.md";
      const result = classifyWorkspacePath(resolved);
      assert.deepEqual(result, { kind: "file", path: "data/wiki/sources/my-source.md" });
    });

    it("resolves ../../../conversations/chat/<id>.jsonl to a session", () => {
      const resolved = "data/wiki/pages/../../../conversations/chat/550e8400-e29b-41d4-a716-446655440000.jsonl";
      const result = classifyWorkspacePath(resolved);
      assert.deepEqual(result, { kind: "session", sessionId: "550e8400-e29b-41d4-a716-446655440000" });
    });

    it("resolves ./other-page.md to a wiki page", () => {
      const resolved = "data/wiki/pages/./other-page.md";
      const result = classifyWorkspacePath(resolved);
      assert.deepEqual(result, { kind: "wiki", slug: "other-page" });
    });

    it("resolves sibling page reference (no prefix needed)", () => {
      const resolved = "data/wiki/pages/sibling.md";
      const result = classifyWorkspacePath(resolved);
      assert.deepEqual(result, { kind: "wiki", slug: "sibling" });
    });
  });

  // ── Fragment / query stripping ────────────────────────────

  describe("strips fragment and query", () => {
    it("strips #fragment from wiki page link", () => {
      const result = classifyWorkspacePath("data/wiki/pages/my-page.md#section");
      assert.deepEqual(result, { kind: "wiki", slug: "my-page" });
    });

    it("strips ?query from file link", () => {
      const result = classifyWorkspacePath("data/file.txt?v=1");
      assert.deepEqual(result, { kind: "file", path: "data/file.txt" });
    });

    it("strips both fragment and query", () => {
      const result = classifyWorkspacePath("data/wiki/pages/foo.md?bar=1#baz");
      assert.deepEqual(result, { kind: "wiki", slug: "foo" });
    });
  });
});

describe("resolveWikiHref", () => {
  const PAGES_BASE = "data/wiki/pages";
  const WIKI_BASE = "data/wiki";

  describe("relative paths (./ and ../)", () => {
    it("prepends baseDir for ../ paths", () => {
      assert.equal(resolveWikiHref("../sources/foo.md", PAGES_BASE), "data/wiki/pages/../sources/foo.md");
    });

    it("prepends baseDir for ./ paths", () => {
      assert.equal(resolveWikiHref("./sibling.md", PAGES_BASE), "data/wiki/pages/./sibling.md");
    });

    it("uses wiki base for log-relative paths", () => {
      assert.equal(resolveWikiHref("./pages/foo.md", WIKI_BASE), "data/wiki/./pages/foo.md");
    });
  });

  describe("bare filenames (no /)", () => {
    it("treats bare .md filename as relative", () => {
      assert.equal(resolveWikiHref("sibling.md", PAGES_BASE), "data/wiki/pages/sibling.md");
    });

    it("treats bare name without extension as relative", () => {
      assert.equal(resolveWikiHref("config", PAGES_BASE), "data/wiki/pages/config");
    });
  });

  describe("external schemes (must pass through unchanged)", () => {
    it("passes through mailto: links", () => {
      assert.equal(resolveWikiHref("mailto:user@example.com", PAGES_BASE), "mailto:user@example.com");
    });

    it("passes through tel: links", () => {
      assert.equal(resolveWikiHref("tel:+819012345678", PAGES_BASE), "tel:+819012345678");
    });

    it("passes through custom scheme links", () => {
      assert.equal(resolveWikiHref("slack://channel/general", PAGES_BASE), "slack://channel/general");
    });

    it("passes through https: links", () => {
      assert.equal(resolveWikiHref("https://example.com", PAGES_BASE), "https://example.com");
    });
  });

  describe("absolute workspace paths (contains /)", () => {
    it("passes through workspace-root-relative paths unchanged", () => {
      assert.equal(resolveWikiHref("data/wiki/sources/foo.md", PAGES_BASE), "data/wiki/sources/foo.md");
    });

    it("passes through conversations path unchanged", () => {
      assert.equal(resolveWikiHref("conversations/chat/abc.jsonl", PAGES_BASE), "conversations/chat/abc.jsonl");
    });
  });
});
