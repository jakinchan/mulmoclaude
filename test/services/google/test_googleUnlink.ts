// Unit tests for unlinkGoogle: best-effort revoke + local token delete.
// The revoke fetch is injected — no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadGoogleTokens, saveGoogleTokens, unlinkGoogle, type RevokeFetch } from "@mulmoclaude/core/google";
import { makeTempDir } from "../../helpers/tempDir.js";

const makeFakeHome = async (): Promise<string> => makeTempDir("google-unlink-test-");

interface RevokeCall {
  url: string;
  body: string;
}

const makeRevokeStub = (result: { status?: number; throwError?: Error } = {}) => {
  const calls: RevokeCall[] = [];
  const revokeFetch: RevokeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: typeof init.body === "string" ? init.body : "" });
    if (result.throwError) throw result.throwError;
    return new Response("", { status: result.status ?? 200 });
  };
  return { revokeFetch, calls };
};

describe("unlinkGoogle", () => {
  it("revokes the refresh token and deletes the local file", async () => {
    const home = await makeFakeHome();
    await saveGoogleTokens({ refresh_token: "refresh-1", access_token: "access-1" }, home);
    const { revokeFetch, calls } = makeRevokeStub();
    await unlinkGoogle(home, revokeFetch);
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? "", /oauth2\.googleapis\.com\/revoke/);
    assert.equal(calls[0]?.body, new URLSearchParams({ token: "refresh-1" }).toString());
    assert.equal(await loadGoogleTokens(home), null);
  });

  it("still deletes the local file when revoke returns non-ok", async () => {
    const home = await makeFakeHome();
    await saveGoogleTokens({ refresh_token: "refresh-1" }, home);
    const { revokeFetch } = makeRevokeStub({ status: 400 });
    await unlinkGoogle(home, revokeFetch);
    assert.equal(await loadGoogleTokens(home), null);
  });

  it("still deletes the local file when the revoke request throws", async () => {
    const home = await makeFakeHome();
    await saveGoogleTokens({ refresh_token: "refresh-1" }, home);
    const { revokeFetch } = makeRevokeStub({ throwError: new Error("network down") });
    await unlinkGoogle(home, revokeFetch);
    assert.equal(await loadGoogleTokens(home), null);
  });

  it("skips the revoke call when no tokens are stored", async () => {
    const home = await makeFakeHome();
    const { revokeFetch, calls } = makeRevokeStub();
    await unlinkGoogle(home, revokeFetch);
    assert.equal(calls.length, 0);
    assert.equal(await loadGoogleTokens(home), null);
  });

  it("falls back to revoking the access token when no refresh token exists", async () => {
    const home = await makeFakeHome();
    await saveGoogleTokens({ access_token: "access-only" }, home);
    const { revokeFetch, calls } = makeRevokeStub();
    await unlinkGoogle(home, revokeFetch);
    assert.equal(calls[0]?.body, new URLSearchParams({ token: "access-only" }).toString());
  });
});
