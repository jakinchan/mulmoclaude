// Unit tests for the lint job-summary renderer (`scripts/lint-summary.mjs`).
// The script is plain JS so eslint can load it as a formatter dependency without
// a build step; we import the pure helpers and drive them directly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseEslintJson, renderReport } from "../../scripts/lint-summary.mjs";

const result = (filePath: string, ruleId = "max-lines", severity = 2) => ({
  filePath,
  messages: [{ ruleId, severity }],
});

describe("parseEslintJson", () => {
  // eslint exits non-zero with an EMPTY stdout when it dies before linting (an
  // unreadable config, a plugin that will not load). Reading that as "no findings"
  // made `yarn lint:summary` print a clean report and exit 0 for a lint that never
  // ran — and the pipeline reports this process's status, not eslint's.
  it("rejects empty output rather than reading it as a clean run", () => {
    assert.throws(() => parseEslintJson(""), /wrote no output/);
    assert.throws(() => parseEslintJson("   \n "), /wrote no output/);
  });

  it("accepts the literal `[]` a clean run emits", () => {
    assert.deepEqual(parseEslintJson("[]"), []);
  });

  it("names the input when it is not eslint json", () => {
    assert.throws(() => parseEslintJson("Oops! Something went wrong"), /not eslint --format json/);
  });
});

describe("renderReport areas", () => {
  const cwd = path.sep === "\\" ? "C:\\repo" : "/repo";
  const under = (...parts: string[]) => [cwd, ...parts].join(path.sep);

  // The helpers split on "/", so a path still carrying the platform separator is
  // one segment and lands in `other`. lint_test_windows.yaml lints on Windows
  // daily, where `relative` answers `server\api\x.ts`.
  it("classifies by area using the platform's own separator", () => {
    const report = renderReport([result(under("server", "api", "x.ts"))], cwd);
    assert.match(report, /"server" : 1/);
    assert.doesNotMatch(report, /"other"/);
  });

  // `areaOf` matches a whole first segment. A `startsWith` would put every
  // e2e-live finding under `e2e`, silently emptying a column of the table.
  it("keeps `e2e-live` out of `e2e`", () => {
    const report = renderReport([result(under("e2e-live", "tests", "x.spec.ts"))], cwd);
    assert.match(report, /"e2e-live" : 1/);
    assert.doesNotMatch(report, /"e2e" : /);
  });

  // ~50 workspaces share the one `packages` slice, so the directory table is the
  // only thing that says WHICH package a finding is in.
  it("breaks a packages finding down to its workspace in the directory table", () => {
    const report = renderReport([result(under("packages", "core", "src", "x.ts"))], cwd);
    assert.match(report, /"packages" : 1/);
    assert.match(report, /packages\/core\/src/);
  });

  it("groups a directory three levels deep with forward slashes", () => {
    const report = renderReport([result(under("test", "scripts", "nested", "x.ts"))], cwd);
    assert.match(report, /test\/scripts\/nested/);
  });

  it("puts a root-level file in `other`", () => {
    const report = renderReport([result(under("vite.config.ts"))], cwd);
    assert.match(report, /"other" : 1/);
  });

  it("counts errors and warnings separately", () => {
    const report = renderReport([result(under("src", "a.ts"), "r", 2), result(under("src", "b.ts"), "r", 1)], cwd);
    assert.match(report, /2 \(1 error, 1 warning\)/);
  });

  it("says so when there is nothing to report", () => {
    assert.match(renderReport([], cwd), /Nothing reported\./);
  });
});
