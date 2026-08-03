// Tests for `server/utils/dev-plugin-args.mjs` — the shared
// `--dev-plugin` parser used by the npm launcher
// (`packages/mulmoclaude/bin/mulmoclaude.js`).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { parseDevPluginArgs } from "../../server/utils/dev-plugin-args.mjs";

// Use cross-platform absolute paths via path.resolve. Hardcoding
// POSIX-style "/abs/..." breaks on Windows where path.resolve("D:/cwd",
// "/abs") returns "D:\abs" — the drive letter from cwd gets prepended
// to a leading-slash path. Anchor every fixture against a real
// path.resolve so the test stays runnable in the lint_test windows-2022
// matrix cell.
const FIXTURE_CWD = path.resolve("/Users/dev/project");
const FIXTURE_ABS_FOO = path.resolve(FIXTURE_CWD, "..", "abs", "foo");
const FIXTURE_ABS_A = path.resolve(FIXTURE_CWD, "..", "abs", "a");
const FIXTURE_ABS_B = path.resolve(FIXTURE_CWD, "..", "abs", "b");
const FIXTURE_ABS_P = path.resolve(FIXTURE_CWD, "..", "abs", "p");
const FIXTURE_ELSEWHERE = path.resolve("/elsewhere/x");

describe("parseDevPluginArgs — extraction", () => {
  it("returns no resolved entries when --dev-plugin is absent", () => {
    const result = parseDevPluginArgs(["--port", "3001", "--no-open"], FIXTURE_CWD);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.resolved, []);
  });

  it("extracts a single occurrence with the verbatim raw input + abs path", () => {
    const result = parseDevPluginArgs(["--dev-plugin", FIXTURE_ABS_FOO], FIXTURE_CWD);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolved.length, 1);
      const [entry] = result.resolved;
      assert.ok(entry);
      assert.equal(entry.rawInput, FIXTURE_ABS_FOO);
      assert.equal(entry.absPath, FIXTURE_ABS_FOO);
    }
  });

  it("preserves multiple occurrences in argv order", () => {
    const result = parseDevPluginArgs(["--dev-plugin", FIXTURE_ABS_A, "--port", "3001", "--dev-plugin", FIXTURE_ABS_B], FIXTURE_CWD);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolved.length, 2);
      const [first, second] = result.resolved;
      assert.ok(first);
      assert.ok(second);
      assert.equal(first.rawInput, FIXTURE_ABS_A);
      assert.equal(second.rawInput, FIXTURE_ABS_B);
    }
  });

  it("ignores unrelated flags interleaved with --dev-plugin", () => {
    const result = parseDevPluginArgs(["--port", "3097", "--dev-plugin", FIXTURE_ABS_P, "--no-open"], FIXTURE_CWD);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolved.length, 1);
      const [entry] = result.resolved;
      assert.ok(entry);
      assert.equal(entry.absPath, FIXTURE_ABS_P);
    }
  });
});

describe("parseDevPluginArgs — path resolution", () => {
  it("resolves relative paths against the supplied cwd", () => {
    const result = parseDevPluginArgs(["--dev-plugin", "./my-plugin"], FIXTURE_CWD);
    assert.equal(result.ok, true);
    if (result.ok) {
      const [entry] = result.resolved;
      assert.ok(entry);
      assert.equal(entry.rawInput, "./my-plugin");
      assert.equal(entry.absPath, path.resolve(FIXTURE_CWD, "my-plugin"));
    }
  });

  it("resolves parent-relative paths against cwd (../foo, etc.)", () => {
    const result = parseDevPluginArgs(["--dev-plugin", "../sibling"], FIXTURE_CWD);
    assert.equal(result.ok, true);
    if (result.ok) {
      const [entry] = result.resolved;
      assert.ok(entry);
      assert.equal(entry.absPath, path.resolve(FIXTURE_CWD, "../sibling"));
    }
  });

  it("leaves absolute paths unchanged regardless of cwd", () => {
    const result = parseDevPluginArgs(["--dev-plugin", FIXTURE_ELSEWHERE], path.resolve("/Users/somewhere/else"));
    assert.equal(result.ok, true);
    if (result.ok) {
      const [entry] = result.resolved;
      assert.ok(entry);
      assert.equal(entry.absPath, FIXTURE_ELSEWHERE);
    }
  });
});

describe("parseDevPluginArgs — error paths", () => {
  it("rejects --dev-plugin at end of argv", () => {
    const result = parseDevPluginArgs(["--port", "3001", "--dev-plugin"], FIXTURE_CWD);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /requires a path argument/);
  });

  it("rejects --dev-plugin followed by another flag", () => {
    // `--dev-plugin --no-open` is a typo for `--dev-plugin <path>`;
    // catching it early prevents loading "--no-open" as a plugin path.
    const result = parseDevPluginArgs(["--dev-plugin", "--no-open"], FIXTURE_CWD);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /requires a path argument/);
  });

  it("first invalid occurrence wins — does NOT silently accumulate later valid ones", () => {
    // Pre-empts a future refactor that would skip the bad flag and
    // continue. We bail eagerly so the user sees the typo before
    // mulmoclaude boots half-configured.
    const result = parseDevPluginArgs(["--dev-plugin", "--bogus", "--dev-plugin", FIXTURE_ABS_FOO], FIXTURE_CWD);
    assert.equal(result.ok, false);
  });
});
