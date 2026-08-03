// Unit tests for the Google token store: merge semantics (refresh-token
// preservation) and the 600-mode file roundtrip against a fake home dir.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";

import path from "node:path";

import { googleTokenPath, legacyGoogleTokenPath, loadGoogleTokens, mergeGoogleTokens, saveGoogleTokens } from "@mulmoclaude/core/google";
import { makeTempDir } from "../../helpers/tempDir.js";

const makeFakeHome = async (): Promise<string> => makeTempDir("google-token-test-");

const POSIX_MODE_MASK = 0o777;

describe("mergeGoogleTokens", () => {
  it("keeps the stored refresh_token when a refresh response omits it", () => {
    const existing = { refresh_token: "keep-me", access_token: "old" };
    const incoming = { access_token: "new", expiry_date: 123 };
    assert.deepEqual(mergeGoogleTokens(existing, incoming), { refresh_token: "keep-me", access_token: "new", expiry_date: 123 });
  });

  it("keeps the stored refresh_token when the incoming one is null", () => {
    const merged = mergeGoogleTokens({ refresh_token: "keep-me" }, { refresh_token: null, access_token: "new" });
    assert.equal(merged.refresh_token, "keep-me");
  });

  it("adopts a newly issued refresh_token", () => {
    const merged = mergeGoogleTokens({ refresh_token: "old" }, { refresh_token: "rotated" });
    assert.equal(merged.refresh_token, "rotated");
  });

  it("works with no existing tokens", () => {
    assert.deepEqual(mergeGoogleTokens(null, { access_token: "a" }), { access_token: "a" });
  });

  it("returns the incoming shape for an empty incoming object", () => {
    assert.deepEqual(mergeGoogleTokens({ refresh_token: "keep-me" }, {}), { refresh_token: "keep-me" });
  });
});

describe("token file roundtrip", () => {
  it("returns null when no token file exists", async () => {
    const home = await makeFakeHome();
    assert.equal(await loadGoogleTokens(home), null);
  });

  it("saves and reloads tokens through the fake home", async () => {
    const home = await makeFakeHome();
    await saveGoogleTokens({ refresh_token: "r1", access_token: "a1" }, home);
    assert.deepEqual(await loadGoogleTokens(home), { refresh_token: "r1", access_token: "a1" });
  });

  it("merges on save so a token rotation cannot drop the refresh token", async () => {
    const home = await makeFakeHome();
    await saveGoogleTokens({ refresh_token: "r1", access_token: "a1" }, home);
    await saveGoogleTokens({ access_token: "a2", expiry_date: 42 }, home);
    assert.deepEqual(await loadGoogleTokens(home), { refresh_token: "r1", access_token: "a2", expiry_date: 42 });
  });

  it("writes the token file with mode 600", async (testContext) => {
    if (process.platform === "win32") {
      testContext.skip("POSIX file modes do not apply on Windows");
      return;
    }
    const home = await makeFakeHome();
    await saveGoogleTokens({ refresh_token: "r1" }, home);
    const tokenFileStat = await stat(googleTokenPath(home));
    assert.equal(tokenFileStat.mode & POSIX_MODE_MASK, 0o600);
  });

  it("migrates a pre-0.20.1 token file from the mulmoclaude-branded dir on load", async () => {
    const home = await makeFakeHome();
    const legacy = legacyGoogleTokenPath(home);
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify({ refresh_token: "legacy-token" }), { mode: 0o600 });
    assert.deepEqual(await loadGoogleTokens(home), { refresh_token: "legacy-token" });
    assert.equal(
      await loadGoogleTokens(home).then(() =>
        stat(legacy).then(
          () => true,
          () => false,
        ),
      ),
      false,
    );
    if (process.platform !== "win32") {
      const migratedStat = await stat(googleTokenPath(home));
      assert.equal(migratedStat.mode & POSIX_MODE_MASK, 0o600);
    }
  });

  it("prefers the new path when both files exist and leaves the legacy copy", async () => {
    const home = await makeFakeHome();
    await saveGoogleTokens({ refresh_token: "current" }, home);
    const legacy = legacyGoogleTokenPath(home);
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify({ refresh_token: "stale" }), { mode: 0o600 });
    assert.deepEqual(await loadGoogleTokens(home), { refresh_token: "current" });
    assert.equal(
      await stat(legacy).then(
        () => true,
        () => false,
      ),
      true,
    );
  });

  it("falls back to reading the legacy file when migration cannot move it", async () => {
    const home = await makeFakeHome();
    // Occupy the new path with a DIRECTORY: the exclusive copy and the new-path
    // read both fail, exercising the migration-failure fallback portably.
    await mkdir(googleTokenPath(home), { recursive: true });
    const legacy = legacyGoogleTokenPath(home);
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify({ refresh_token: "legacy-token" }), { mode: 0o600 });
    assert.deepEqual(await loadGoogleTokens(home), { refresh_token: "legacy-token" });
    assert.equal(
      await stat(legacy).then(
        () => true,
        () => false,
      ),
      true,
    );
  });

  it("returns null for a corrupted token file instead of throwing", async () => {
    const home = await makeFakeHome();
    await mkdir(path.dirname(googleTokenPath(home)), { recursive: true });
    await writeFile(googleTokenPath(home), "{not json", "utf-8");
    assert.equal(await loadGoogleTokens(home), null);
  });
});
