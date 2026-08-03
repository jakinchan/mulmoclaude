// Tests for dev-mode plugin loading (PR2 of #1159).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  detectDevCollisions,
  DEV_VERSION,
  evaluateDevPluginGate,
  loadDevPlugins,
  parseDevPluginsEnv,
  validateDevPluginPath,
} from "../../server/plugins/dev-loader.js";
import type { RuntimePlugin } from "../../server/plugins/runtime-loader.js";
import { makeTempDir } from "../helpers/tempDir.js";

interface FixtureOpts {
  /** Override the package.json's `name`. Default `@fixture/dev-plugin`. */
  pkgName?: string;
  /** When true, omit `package.json` entirely. */
  omitPackageJson?: boolean;
  /** When true, omit the `name` field on package.json. */
  omitNameField?: boolean;
  /** When true, skip writing dist/index.js. */
  omitDistEntry?: boolean;
}

function makeDevPluginFixture(opts: FixtureOpts = {}): string {
  const dir = makeTempDir("mulmo-dev-plugin-");
  if (!opts.omitPackageJson) {
    const pkg: Record<string, unknown> = {
      version: "0.1.0",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    };
    if (!opts.omitNameField) pkg.name = opts.pkgName ?? "@fixture/dev-plugin";
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  }
  if (!opts.omitDistEntry) {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(
      path.join(dir, "dist", "index.js"),
      `export const TOOL_DEFINITION = {
  name: "fixtureDev",
  description: "dev fixture",
  parameters: { type: "object", properties: {}, required: [] }
};
`,
    );
  }
  return dir;
}

describe("parseDevPluginsEnv", () => {
  it("returns [] when env is undefined", () => {
    assert.deepEqual(parseDevPluginsEnv(undefined, "/tmp"), []);
  });

  it("returns [] when env is empty string", () => {
    assert.deepEqual(parseDevPluginsEnv("", "/tmp"), []);
  });

  it("splits on the platform path delimiter", () => {
    // Use a cwd as the anchor so the test stays cross-platform —
    // `path.resolve` normalises drive letters on Windows. Hardcoded
    // POSIX-style abs paths fail there because `path.resolve("D:/cwd",
    // "/abs/a")` returns `"D:\abs\a"`.
    const cwd = path.resolve("/tmp/cwd");
    const inputA = path.resolve(cwd, "abs", "a");
    const inputB = path.resolve(cwd, "abs", "b");
    const value = [inputA, inputB].join(path.delimiter);
    const result = parseDevPluginsEnv(value, cwd);
    assert.equal(result.length, 2);
    const [entryA, entryB] = result;
    assert.ok(entryA);
    assert.ok(entryB);
    assert.equal(entryA.rawInput, inputA);
    assert.equal(entryA.absPath, inputA);
    assert.equal(entryB.rawInput, inputB);
    assert.equal(entryB.absPath, inputB);
  });

  it("resolves relative paths against the supplied cwd", () => {
    const cwd = path.resolve("/tmp/cwd");
    const result = parseDevPluginsEnv("./local", cwd);
    assert.equal(result.length, 1);
    const [entry] = result;
    assert.ok(entry);
    assert.equal(entry.rawInput, "./local");
    assert.equal(entry.absPath, path.resolve(cwd, "local"));
  });

  it("ignores empty segments (consecutive delimiters)", () => {
    // Pre-empts a launcher bug where joining an empty array element
    // produced ":foo:" — we'd want ["foo"] not ["", "foo", ""].
    const value = `${path.delimiter}/abs/a${path.delimiter}${path.delimiter}/abs/b${path.delimiter}`;
    const result = parseDevPluginsEnv(value, "/tmp");
    assert.equal(result.length, 2);
  });
});

describe("validateDevPluginPath", () => {
  it("returns ok with the package name on a healthy fixture", async () => {
    const dir = makeDevPluginFixture();
    const result = await validateDevPluginPath(dir);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.name, "@fixture/dev-plugin");
  });

  it("rejects a missing path", async () => {
    const ghost = path.join(tmpdir(), "mulmo-dev-plugin-does-not-exist-12345");
    const result = await validateDevPluginPath(ghost);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /does not exist/);
  });

  it("rejects a path that is a file, not a directory", async () => {
    const dir = makeTempDir("mulmo-dev-plugin-file-");
    const filePath = path.join(dir, "not-a-dir");
    writeFileSync(filePath, "");
    const result = await validateDevPluginPath(filePath);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not a directory/);
  });

  it("rejects a directory missing package.json", async () => {
    const dir = makeDevPluginFixture({ omitPackageJson: true });
    const result = await validateDevPluginPath(dir);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /package\.json not found/);
  });

  it("rejects a package.json without a `name` field", async () => {
    const dir = makeDevPluginFixture({ omitNameField: true });
    const result = await validateDevPluginPath(dir);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /no "name" field/);
  });

  it("rejects when dist/index.js is missing — error mentions yarn build", async () => {
    const dir = makeDevPluginFixture({ omitDistEntry: true });
    const result = await validateDevPluginPath(dir);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /dist\/index\.js not found/);
      assert.match(result.reason, /yarn build/);
    }
  });
});

describe("loadDevPlugins", () => {
  it("loads a healthy fixture and stamps DEV_VERSION", async () => {
    const dir = makeDevPluginFixture();
    const { plugins, errors } = await loadDevPlugins([{ rawInput: dir, absPath: dir }]);
    assert.deepEqual(errors, []);
    assert.equal(plugins.length, 1);
    const [loaded] = plugins;
    assert.ok(loaded);
    assert.equal(loaded.name, "@fixture/dev-plugin");
    assert.equal(loaded.version, DEV_VERSION);
    assert.equal(loaded.cachePath, dir);
  });

  it("collects errors for invalid inputs without throwing", async () => {
    const ghost = path.join(tmpdir(), "mulmo-dev-plugin-ghost-12345");
    const { plugins, errors } = await loadDevPlugins([{ rawInput: ghost, absPath: ghost }]);
    assert.deepEqual(plugins, []);
    assert.equal(errors.length, 1);
    const [error] = errors;
    assert.ok(error);
    assert.match(error, /does not exist/);
  });

  it("loads multiple plugins independently — failure of one does not block the other", async () => {
    const okDir = makeDevPluginFixture({ pkgName: "@fixture/ok-one" });
    const ghost = path.join(tmpdir(), "mulmo-dev-plugin-ghost-67890");
    const { plugins, errors } = await loadDevPlugins([
      { rawInput: ghost, absPath: ghost },
      { rawInput: okDir, absPath: okDir },
    ]);
    assert.equal(plugins.length, 1);
    const [loaded] = plugins;
    assert.ok(loaded);
    assert.equal(loaded.name, "@fixture/ok-one");
    assert.equal(errors.length, 1);
  });
});

function fakePlugin(name: string, cachePath: string): RuntimePlugin {
  return {
    name,
    version: DEV_VERSION,
    cachePath,
    definition: { type: "function", name: `tool_${name}`, description: "", parameters: { type: "object", properties: {}, required: [] } },
    execute: async () => ({}),
    oauthCallbackAlias: null,
  };
}

describe("detectDevCollisions", () => {
  it("returns [] when names are all unique across dev + prod", () => {
    const dev = [fakePlugin("@a/one", "/dev/one")];
    const prod = [fakePlugin("@a/two", "/prod/two")];
    assert.deepEqual(detectDevCollisions(dev, prod), []);
  });

  it("flags two dev plugins with the same name and lists both abs paths", () => {
    const dev = [fakePlugin("@a/dup", "/dev/first"), fakePlugin("@a/dup", "/dev/second")];
    const collisions = detectDevCollisions(dev, []);
    assert.equal(collisions.length, 1);
    const [collision] = collisions;
    assert.ok(collision);
    assert.equal(collision.name, "@a/dup");
    assert.deepEqual(collision.sources, ["/dev/first", "/dev/second"]);
  });

  it("flags a dev plugin colliding with an installed plugin and tags the prod source", () => {
    const dev = [fakePlugin("@a/conflict", "/dev/here")];
    const prod = [fakePlugin("@a/conflict", "/prod/cache/conflict")];
    const collisions = detectDevCollisions(dev, prod);
    assert.equal(collisions.length, 1);
    const [collision] = collisions;
    assert.ok(collision);
    assert.equal(collision.name, "@a/conflict");
    assert.deepEqual(collision.sources, ["/dev/here", "(installed) /prod/cache/conflict"]);
  });

  it("reports both kinds of collision in one pass", () => {
    const dev = [fakePlugin("@a/dup", "/dev/a"), fakePlugin("@a/dup", "/dev/b"), fakePlugin("@a/conflict", "/dev/c")];
    const prod = [fakePlugin("@a/conflict", "/prod/c")];
    const collisions = detectDevCollisions(dev, prod);
    assert.equal(collisions.length, 2);
    const dup = collisions.find((entry) => entry.name === "@a/dup");
    const conflict = collisions.find((entry) => entry.name === "@a/conflict");
    assert.ok(dup);
    assert.ok(conflict);
    assert.equal(dup.sources.length, 2);
    assert.equal(conflict.sources.length, 2);
  });
});

describe("evaluateDevPluginGate", () => {
  it("ok=true with the loaded plugins when devLoad has no errors AND no collisions", () => {
    const devLoad = { plugins: [fakePlugin("@a/one", "/dev/one")], errors: [] };
    const verdict = evaluateDevPluginGate(devLoad, []);
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.equal(verdict.plugins.length, 1);
      const [gated] = verdict.plugins;
      assert.ok(gated);
      assert.equal(gated.name, "@a/one");
    }
  });

  it("ok=false when devLoad has any errors — fatalMessages include each error + a refusing-to-start summary", () => {
    const devLoad = { plugins: [], errors: ["./bad: dist/index.js not found at /abs/bad/dist/index.js"] };
    const verdict = evaluateDevPluginGate(devLoad, []);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.fatalMessages.length, 2);
      const [loadFailure, summary] = verdict.fatalMessages;
      assert.ok(loadFailure);
      assert.ok(summary);
      assert.match(loadFailure, /dist\/index\.js not found/);
      assert.match(summary, /refusing to start/);
    }
  });

  it("ok=false when there's a dev/prod name collision — fatalMessages include the abs paths and a summary", () => {
    const devLoad = { plugins: [fakePlugin("@a/conflict", "/dev/path")], errors: [] };
    const prod = [fakePlugin("@a/conflict", "/prod/cache/conflict")];
    const verdict = evaluateDevPluginGate(devLoad, prod);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      const joined = verdict.fatalMessages.join("\n");
      assert.match(joined, /name collision: @a\/conflict/);
      assert.match(joined, /\/dev\/path/);
      assert.match(joined, /\(installed\) \/prod\/cache\/conflict/);
      assert.match(joined, /refusing to start/);
    }
  });

  it("errors take precedence over collisions — short-circuits before the collision pass", () => {
    // If we couldn't even load the dev plugin, the collision check is
    // moot. The dev needs to fix the load failure first.
    const devLoad = { plugins: [], errors: ["broken: package.json missing"] };
    const prod = [fakePlugin("@a/anything", "/prod/whatever")];
    const verdict = evaluateDevPluginGate(devLoad, prod);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      const joined = verdict.fatalMessages.join("\n");
      assert.match(joined, /package\.json missing/);
      // Collision message should NOT appear — we bailed earlier.
      assert.doesNotMatch(joined, /name collision/);
    }
  });
});
