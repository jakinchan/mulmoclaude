// The launcher's release audit must see the app code only it can ship (#2827).
//
// Every workspace's shipped source sits under its own directory — except
// `mulmoclaude`, whose `files` name `server/` and `src/` that `prepack` copies
// in from the repo root. A diff scoped to `packages/mulmoclaude` therefore
// reported the launcher clean while a `server/` change sat undelivered, which
// is what happened right after #2824 merged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffPathspec, externalSourceRoots, isReleasePath, shippedRoots } from "../../../scripts/packages/audit-releases.mjs";

const launcher = {
  dir: "packages/mulmoclaude",
  name: "mulmoclaude",
  files: ["bin/", "client/", "server/", "src/", "Dockerfile.sandbox", "sandbox-entrypoint.sh"],
};

const plugin = {
  dir: "packages/plugins/chart-plugin",
  name: "@mulmoclaude/chart-plugin",
  files: ["dist"],
};

describe("externalSourceRoots", () => {
  it("gives the launcher the repo-root dirs prepack copies in", () => {
    assert.deepEqual(externalSourceRoots(launcher), ["server", "src", "Dockerfile.sandbox", "sandbox-entrypoint.sh"]);
  });

  it("gives every other workspace none", () => {
    assert.deepEqual(externalSourceRoots(plugin), []);
    assert.deepEqual(externalSourceRoots({ dir: "packages/core", name: "@mulmoclaude/core" }), []);
  });
});

describe("diffPathspec", () => {
  it("widens the launcher's diff beyond its own directory", () => {
    const spec = diffPathspec(launcher);
    assert.ok(spec.includes("packages/mulmoclaude"), "own dir still covered");
    assert.ok(spec.includes("server"), "root server/ is what only the launcher ships");
    assert.ok(spec.includes("src"), "root src/ feeds both src/ and the client bundle");
  });

  it("leaves other workspaces scoped to their own directory", () => {
    assert.deepEqual(diffPathspec(plugin), ["packages/plugins/chart-plugin"]);
  });
});

describe("isReleasePath — launcher", () => {
  it("counts repo-root app code as shipped", () => {
    assert.equal(isReleasePath(launcher, "server/agent/stream.ts"), true);
    assert.equal(isReleasePath(launcher, "src/utils/session/sessionHelpers.ts"), true);
    assert.equal(isReleasePath(launcher, "Dockerfile.sandbox"), true);
    assert.equal(isReleasePath(launcher, "sandbox-entrypoint.sh"), true);
  });

  it("does NOT count the root package.json — it is not in the tarball", () => {
    assert.equal(isReleasePath(launcher, "package.json"), false);
  });

  it("does NOT count other repo-root paths", () => {
    assert.equal(isReleasePath(launcher, "docs/package-releases.md"), false);
    assert.equal(isReleasePath(launcher, "test/agent/test_injectedText.ts"), false);
    assert.equal(isReleasePath(launcher, "scripts/packages/audit-releases.mjs"), false);
  });

  it("still counts files inside its own directory", () => {
    assert.equal(isReleasePath(launcher, "packages/mulmoclaude/bin/mulmoclaude.js"), true);
    assert.equal(isReleasePath(launcher, "packages/mulmoclaude/README.md"), true);
  });

  // A root path must ship because the package DECLARED it, not because its
  // first segment happens to collide with a `files` entry. Both packages below
  // list `src`; only the launcher copies the repo's root `src/` into its tarball.
  it("does not let another package's files entry claim a repo-root path", () => {
    const libWithSrcInFiles = { dir: "packages/core", name: "@mulmoclaude/core", files: ["dist", "src"] };
    assert.equal(isReleasePath(libWithSrcInFiles, "src/utils/session/sessionHelpers.ts"), false);
    assert.equal(isReleasePath(libWithSrcInFiles, "server/agent/stream.ts"), false);
  });
});

describe("isReleasePath — ordinary workspaces (unchanged behaviour)", () => {
  it("counts build inputs and declared roots under the package dir", () => {
    assert.equal(isReleasePath(plugin, "packages/plugins/chart-plugin/src/index.ts"), true);
    assert.equal(isReleasePath(plugin, "packages/plugins/chart-plugin/dist/index.js"), true);
  });

  it("counts README, which npm ships regardless of `files`", () => {
    assert.equal(isReleasePath(plugin, "packages/plugins/chart-plugin/README.md"), true);
  });

  it("skips files that do not feed the tarball", () => {
    assert.equal(isReleasePath(plugin, "packages/plugins/chart-plugin/test/test_chart.ts"), false);
    assert.equal(isReleasePath(plugin, "packages/plugins/chart-plugin/eslint.config.mjs"), false);
  });
});

describe("shippedRoots", () => {
  it("normalises trailing slashes, globs and ./ prefixes", () => {
    assert.deepEqual(shippedRoots({ files: ["dist/", "./assets", "lib/**/*.js"] }), ["dist", "assets", "lib"]);
  });

  it("returns none when the package declares no files", () => {
    assert.deepEqual(shippedRoots({}), []);
  });
});
