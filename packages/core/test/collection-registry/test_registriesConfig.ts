// Unit tests for the pure `parseRegistriesConfig` helper exported by
// `collection/registry/server/registriesConfig.ts`. The full I/O
// wrapper (`loadRegistriesConfig`) is exercised in integration; here we pin the
// classification rules so a regression in URL validation / name uniqueness /
// reserved-name handling can't slip past without a failing test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseRegistriesConfig, OFFICIAL_REGISTRY_NAME } from "../../src/collection/registry/server/registriesConfig.ts";

const validEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "myorg",
  indexUrl: "https://example.test/myorg/index.json",
  rawBaseUrl: "https://example.test/myorg-raw",
  ...overrides,
});

describe("parseRegistriesConfig — basic acceptance", () => {
  it("accepts a well-formed single-entry array", () => {
    const result = parseRegistriesConfig([validEntry()]);
    assert.equal(result.length, 1);
    const [registry] = result;
    assert.ok(registry);
    assert.equal(registry.name, "myorg");
    assert.equal(registry.indexUrl, "https://example.test/myorg/index.json");
    assert.equal(registry.rawBaseUrl, "https://example.test/myorg-raw");
  });

  it("normalizes a trailing slash on rawBaseUrl", () => {
    // The URL joiner appends `/path`, so a user-written trailing slash would
    // produce a double slash. Strip it once at parse time so the rest of the
    // pipeline doesn't need to think about it.
    const result = parseRegistriesConfig([validEntry({ rawBaseUrl: "https://example.test/myorg-raw///" })]);
    const [registry] = result;
    assert.ok(registry);
    assert.equal(registry.rawBaseUrl, "https://example.test/myorg-raw");
  });

  it("returns the entries in source order — the Discover view shows them in config order", () => {
    const result = parseRegistriesConfig([validEntry({ name: "alpha" }), validEntry({ name: "beta" }), validEntry({ name: "gamma" })]);
    assert.deepEqual(
      result.map((reg) => reg.name),
      ["alpha", "beta", "gamma"],
    );
  });

  it("returns an empty list when the top-level shape is not an array", () => {
    assert.deepEqual(parseRegistriesConfig({}), []);
    assert.deepEqual(parseRegistriesConfig(null), []);
    assert.deepEqual(parseRegistriesConfig("not an array"), []);
    assert.deepEqual(parseRegistriesConfig(42), []);
  });
});

describe("parseRegistriesConfig — drops invalid entries (rest still load)", () => {
  it("drops an entry whose name uses disallowed characters", () => {
    const result = parseRegistriesConfig([validEntry({ name: "has space" }), validEntry({ name: "valid" })]);
    assert.deepEqual(
      result.map((reg) => reg.name),
      ["valid"],
    );
  });

  it("drops an entry that reuses the reserved official name", () => {
    const result = parseRegistriesConfig([validEntry({ name: OFFICIAL_REGISTRY_NAME }), validEntry({ name: "ok" })]);
    assert.deepEqual(
      result.map((reg) => reg.name),
      ["ok"],
    );
  });

  it("drops an entry with a non-HTTPS indexUrl (no http, ftp, file)", () => {
    // `javascript:alert(1)` is built up at runtime so the lint rule against
    // script-URL literals doesn't fire on a test that's specifically asserting
    // the parser rejects it.
    const scriptScheme = `${"java"}${"script:"}alert(1)`;
    for (const indexUrl of ["http://example.test/i.json", "ftp://example.test/i.json", "file:///tmp/i.json", scriptScheme]) {
      const result = parseRegistriesConfig([validEntry({ indexUrl }), validEntry({ name: "ok" })]);
      assert.deepEqual(
        result.map((reg) => reg.name),
        ["ok"],
        `${indexUrl} should be dropped`,
      );
    }
  });

  it("drops an entry whose rawBaseUrl is malformed", () => {
    const result = parseRegistriesConfig([validEntry({ rawBaseUrl: "not a url" }), validEntry({ name: "ok" })]);
    assert.deepEqual(
      result.map((reg) => reg.name),
      ["ok"],
    );
  });

  it("drops an entry whose indexUrl carries embedded credentials", () => {
    // Credentials in the URL would otherwise leak via logs / Sentry / fetch
    // metrics. Force users to put auth in headers (currently unsupported) or
    // not at all.
    const result = parseRegistriesConfig([validEntry({ indexUrl: "https://user:pass@example.test/i.json" }), validEntry({ name: "ok" })]);
    assert.deepEqual(
      result.map((reg) => reg.name),
      ["ok"],
    );
  });

  it("drops an entry whose rawBaseUrl contains a query string or fragment", () => {
    // rawBaseUrl is joined as `${rawBase}/<path>`; a `?` or `#` would land in
    // the middle of every composed collection-file URL and break the fetch.
    // CodeRabbit review on #1837.
    for (const rawBaseUrl of ["https://example.test/raw?x=1", "https://example.test/raw#frag"]) {
      const result = parseRegistriesConfig([validEntry({ rawBaseUrl }), validEntry({ name: "ok" })]);
      assert.deepEqual(
        result.map((reg) => reg.name),
        ["ok"],
        `${rawBaseUrl} should be dropped`,
      );
    }
  });

  it("ALLOWS a query string in indexUrl (the index is fetched directly, no path-join)", () => {
    // Asymmetric on purpose — indexUrl is just fetched; only rawBaseUrl gets joined.
    const result = parseRegistriesConfig([validEntry({ indexUrl: "https://example.test/index.json?v=1" })]);
    assert.equal(result.length, 1);
    const [registry] = result;
    assert.ok(registry);
    assert.equal(registry.indexUrl, "https://example.test/index.json?v=1");
  });

  it("dedupes on name (first wins, later duplicates dropped)", () => {
    const result = parseRegistriesConfig([
      validEntry({ name: "dup", indexUrl: "https://example.test/first/index.json" }),
      validEntry({ name: "dup", indexUrl: "https://example.test/second/index.json" }),
      validEntry({ name: "other" }),
    ]);
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((reg) => reg.name),
      ["dup", "other"],
    );
    const [winner] = result;
    assert.ok(winner);
    assert.equal(winner.indexUrl, "https://example.test/first/index.json");
  });

  it("drops a non-object entry without breaking the array", () => {
    const result = parseRegistriesConfig([null, "string", 42, validEntry()]);
    assert.deepEqual(
      result.map((reg) => reg.name),
      ["myorg"],
    );
  });
});
