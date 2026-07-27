// The server's own `.env` load (#2610) — what `import "dotenv/config"`
// used to do, plus the part it threw away.
//
// `applyEnvFile` takes its cwd and its target as arguments precisely so
// this file never touches `process.cwd()` / `process.env`; the module's
// own one-shot call against the real ones is the only place that does.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEnvFile, type MutableEnv } from "../../server/system/loadEnv.js";

let dir: string;
const writeEnv = (contents: string) => writeFileSync(path.join(dir, ".env"), contents);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "test-load-env-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("applyEnvFile", () => {
  it("applies a key the target doesn't have", () => {
    writeEnv("GEMINI_API_KEY=from-file\n");
    const target: MutableEnv = {};
    assert.deepEqual(applyEnvFile(dir, target), []);
    assert.equal(target.GEMINI_API_KEY, "from-file");
  });

  it("leaves an existing value alone and reports it as shadowed", () => {
    writeEnv("GEMINI_API_KEY=from-file\n");
    const target: MutableEnv = { GEMINI_API_KEY: "from-shell" };
    assert.deepEqual(applyEnvFile(dir, target), ["GEMINI_API_KEY"]);
    assert.equal(target.GEMINI_API_KEY, "from-shell", "the shell value must win, as dotenv always did");
  });

  it("reports only the keys that actually lost", () => {
    writeEnv("A=file\nB=file\nC=file\n");
    const target: MutableEnv = { B: "shell" };
    assert.deepEqual(applyEnvFile(dir, target), ["B"]);
    assert.equal(target.A, "file");
    assert.equal(target.B, "shell");
    assert.equal(target.C, "file");
  });

  it("counts an empty shell value as set — that is the confusing case, not an exception to it", () => {
    // `export GEMINI_API_KEY=` still shadows the file under dotenv, and
    // an empty key that silently beats a real one is exactly the trap
    // this diagnostic exists for.
    writeEnv("GEMINI_API_KEY=from-file\n");
    const target: MutableEnv = { GEMINI_API_KEY: "" };
    assert.deepEqual(applyEnvFile(dir, target), ["GEMINI_API_KEY"]);
    assert.equal(target.GEMINI_API_KEY, "");
  });

  it("is a no-op when there is no .env", () => {
    const target: MutableEnv = { EXISTING: "kept" };
    assert.deepEqual(applyEnvFile(dir, target), []);
    assert.deepEqual(target, { EXISTING: "kept" });
  });

  it("is a no-op for an empty .env", () => {
    writeEnv("");
    const target: MutableEnv = {};
    assert.deepEqual(applyEnvFile(dir, target), []);
    assert.deepEqual(target, {});
  });
});
