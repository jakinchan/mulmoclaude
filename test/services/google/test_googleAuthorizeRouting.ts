// Which client authorizeGoogle picks, per ~/.secrets state. The flows
// themselves need a browser, so these assert the decision only — the point is
// that `ambiguous` fails fast instead of silently linking via the broker
// (which would ignore the user's deliberate setup).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

import path from "node:path";

import { makeTempDir } from "../../helpers/tempDir.js";
import {
  authorizeGoogle,
  clientSecretPresence,
  commitLinkedTokens,
  getGoogleAccessToken,
  googleSecretsDir,
  googleTokenPath,
  loadGoogleTokens,
  saveGoogleTokens,
} from "@mulmoclaude/core/google";

const desktopSecret = JSON.stringify({ installed: { client_id: "id-123", client_secret: "secret-456" } });

const makeFakeHome = async (files: Record<string, string> = {}): Promise<string> => {
  const home = makeTempDir("google-authorize-test-");
  const dir = googleSecretsDir(home);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf-8");
  }
  return home;
};

describe("authorizeGoogle client routing", () => {
  it("refuses to link when two desktop clients are present", async () => {
    const home = await makeFakeHome({ "client_secret_a.json": desktopSecret, "client_secret_b.json": desktopSecret });
    assert.equal(await clientSecretPresence(home), "ambiguous");
    // Rejects before any consent URL is issued — the user has to resolve the
    // ambiguity, not get quietly linked through the broker.
    let issuedUrl: string | null = null;
    await assert.rejects(authorizeGoogle({ home, onAuthUrl: (url) => (issuedUrl = url), timeoutMs: 1_000 }), /multiple desktop-app client_secret/);
    assert.equal(issuedUrl, null);
  });
});

// A restart/cancel can fire after the browser callback resolves, while the
// token exchange is still in flight. commitLinkedTokens is the last checkpoint
// before the one persistent side effect, so an abandoned run must not overwrite
// the link the user actually kept.
describe("commitLinkedTokens cancellation guard", () => {
  it("persists the tokens when the flow was not cancelled", async () => {
    const home = await makeFakeHome();
    const saved = await commitLinkedTokens({ refresh_token: "rt-keep" }, "local", { home });
    assert.equal(saved.refresh_token, "rt-keep");
    assert.equal((await loadGoogleTokens(home))?.refresh_token, "rt-keep");
  });

  it("throws and writes nothing when the run was aborted after the code arrived", async () => {
    const home = await makeFakeHome();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(commitLinkedTokens({ refresh_token: "rt-stale" }, "local", { home, signal: controller.signal }), /authorization cancelled/);
    assert.equal(await loadGoogleTokens(home), null);
  });
});

// A local-issued token needs the client that minted it. The two ways that
// client can go missing have different fixes, and telling the user the wrong
// one costs them a re-consent they did not need.
describe("getGoogleAccessToken guidance for a local-issued token", () => {
  const saveLocalToken = async (home: string): Promise<void> => {
    await mkdir(path.dirname(googleTokenPath(home)), { recursive: true });
    await saveGoogleTokens({ refresh_token: "rt-local", issuedVia: "local" }, home);
  };

  it("points at the duplicate files when two desktop clients are present", async () => {
    const home = await makeFakeHome({ "client_secret_a.json": desktopSecret, "client_secret_b.json": desktopSecret });
    await saveLocalToken(home);
    await assert.rejects(getGoogleAccessToken(home), /multiple desktop-app client_secret/);
  });

  it("asks for a re-link when the desktop client is gone entirely", async () => {
    const home = await makeFakeHome();
    await saveLocalToken(home);
    await assert.rejects(getGoogleAccessToken(home), /link their Google account again/);
  });
});
