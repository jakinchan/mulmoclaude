import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isSafeBundlePath, parseManifest, normalizedDataPath, withNormalizedDataPath } from "../../src/collection/registry/server/importCollection.ts";

describe("isSafeBundlePath", () => {
  it("accepts normal relative bundle paths", () => {
    for (const ok of ["SKILL.md", "schema.json", "views/cinema.html", "seed/items/007-a.json", "templates/x.md"]) {
      assert.ok(isSafeBundlePath(ok), ok);
    }
  });

  it("rejects traversal, absolute, and malformed paths", () => {
    for (const bad of ["", "/etc/passwd", "../secret", "a/../b", "a/./b", "a//b", "a\\b", ".", "..", 42, null, undefined]) {
      assert.ok(!isSafeBundlePath(bad), String(bad));
    }
  });
});

describe("parseManifest", () => {
  it("accepts a well-formed manifest", () => {
    const result = parseManifest({ files: ["SKILL.md", "schema.json", "seed/items/a.json"] });
    assert.ok(result.ok);
    assert.deepEqual(result.files, ["SKILL.md", "schema.json", "seed/items/a.json"]);
  });

  it("rejects a non-object or missing files[]", () => {
    for (const bad of [null, 42, {}, { files: "x" }, { files: {} }]) {
      assert.equal(parseManifest(bad).ok, false);
    }
  });

  it("rejects a manifest containing an unsafe path", () => {
    const result = parseManifest({ files: ["SKILL.md", "../../etc/passwd"] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /unsafe path/);
  });

  // `find` answers `undefined` both for "nothing unsafe" and for "the unsafe
  // entry IS `undefined`", so these read as clean manifests and `filter` then
  // dropped the entry — reporting ok on a manifest that had a bad one. Not
  // reachable through `fetchManifest`, whose input is always `JSON.parse`
  // output, but `parseManifest` is exported from `@mulmoclaude/core`.
  it("rejects an undefined entry rather than filtering it away", () => {
    // Assigned past the end rather than written as `["a", , "b"]`, which is a
    // sparse-array literal and a lint error. Index 1 is a genuine hole.
    const withHole: string[] = ["SKILL.md"];
    withHole[2] = "b.json";
    for (const bad of [{ files: ["SKILL.md", undefined] }, { files: withHole }]) {
      const result = parseManifest(bad);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /unsafe path/);
    }
  });

  // The reachable path: JSON has no `undefined`, so a null entry is what a
  // poisoned manifest.json can actually carry. Guarded before and after.
  it("rejects a null entry", () => {
    assert.equal(parseManifest(JSON.parse('{"files":["SKILL.md",null]}')).ok, false);
  });

  // Rendering the rejected entry must not throw: `JSON.stringify` does on a
  // circular object and on a bigint, and this runs only while REJECTING — a
  // throw would turn a `{ ok: false }` the caller handles into an exception it
  // does not expect.
  // Adversarial rather than representative: the input is `unknown`, so the
  // rendering has to survive a value that fights back. Every escape hatch short
  // of `typeof` runs user code — `String` calls `toString`/`valueOf`,
  // `Object.prototype.toString` reads `Symbol.toStringTag`, and a proxy traps
  // all of it.
  it("rejects, rather than throws, on an entry that cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const hostileProxy = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
        ownKeys() {
          throw new Error("keys");
        },
      },
    );
    const throwingTag = {
      get [Symbol.toStringTag](): string {
        throw new Error("tag");
      },
    };
    const throwingToString = {
      toString() {
        throw new Error("boom");
      },
      valueOf() {
        throw new Error("val");
      },
    };
    for (const entry of [circular, 1n, hostileProxy, throwingTag, throwingToString, Symbol("s"), () => 1]) {
      const result = parseManifest({ files: ["SKILL.md", entry] });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /unsafe path/);
    }
  });
});

describe("dataPath normalization", () => {
  it("derives data/collections/<slug>/items", () => {
    assert.equal(normalizedDataPath("movies"), "data/collections/movies/items");
    assert.equal(normalizedDataPath("isamu-movies"), "data/collections/isamu-movies/items");
  });

  it("replaces the authored dataPath and preserves other fields", () => {
    const schema = { title: "X", icon: "movie", dataPath: "data/movies/items", primaryKey: "id", fields: { id: {} } };
    const out = withNormalizedDataPath(schema, "movies");
    assert.equal(out.dataPath, "data/collections/movies/items");
    assert.equal(out.title, "X");
    assert.equal(out.primaryKey, "id");
    assert.deepEqual(out.fields, { id: {} });
    // input not mutated
    assert.equal(schema.dataPath, "data/movies/items");
  });
});
