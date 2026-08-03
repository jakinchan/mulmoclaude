// Unit tests for the client-secret loader: discovery by prefix in ~/.secrets,
// and the rule that only desktop-app ("installed") clients count — a web
// client legitimately shares that directory for anyone who also deploys the
// broker, and it cannot drive the loopback consent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

import path from "node:path";

import { clientSecretPresence, findClientSecretPath, googleSecretsDir, loadClientSecret } from "@mulmoclaude/core/google";
import { makeTempDir } from "../../helpers/tempDir.js";

const makeFakeHome = async (files: Record<string, string> = {}): Promise<string> => {
  const home = makeTempDir("google-secret-test-");
  const dir = googleSecretsDir(home);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf-8");
  }
  return home;
};

const desktopSecret = JSON.stringify({ installed: { client_id: "id-123", client_secret: "secret-456", redirect_uris: ["http://localhost"] } });
const webSecret = JSON.stringify({ web: { client_id: "web-id", client_secret: "web-secret" } });

describe("findClientSecretPath", () => {
  it("finds a desktop client_secret_*.json by prefix", async () => {
    const home = await makeFakeHome({ "client_secret_abc.apps.googleusercontent.com.json": desktopSecret });
    assert.match(await findClientSecretPath(home), /client_secret_abc/);
  });

  it("ignores unrelated files in ~/.secrets", async () => {
    const home = await makeFakeHome({ "other-key.json": "{}", "client_secret_notes.txt": "nope" });
    await assert.rejects(findClientSecretPath(home), /no desktop-app client_secret/);
  });

  // The broker's own web client sits here for whoever deployed it; it must not
  // make the user's desktop client look ambiguous.
  it("skips a web-app client sharing the directory", async () => {
    const home = await makeFakeHome({ "client_secret_desktop.json": desktopSecret, "client_secret_web.json": webSecret });
    assert.match(await findClientSecretPath(home), /client_secret_desktop/);
  });

  it("skips a malformed file rather than refusing the whole directory", async () => {
    const home = await makeFakeHome({ "client_secret_desktop.json": desktopSecret, "client_secret_broken.json": "{oops" });
    assert.match(await findClientSecretPath(home), /client_secret_desktop/);
  });

  it("fails on ambiguity when multiple desktop clients exist", async () => {
    const home = await makeFakeHome({ "client_secret_b.json": desktopSecret, "client_secret_a.json": desktopSecret });
    await assert.rejects(
      findClientSecretPath(home),
      /multiple desktop-app client_secret_\*\.json files found .*client_secret_a\.json, client_secret_b\.json.* keep exactly one/,
    );
  });

  it("points at the sign-in service when ~/.secrets does not exist", async () => {
    const home = makeTempDir("google-secret-test-");
    await assert.rejects(findClientSecretPath(home), /links through the sign-in service/);
  });
});

describe("clientSecretPresence", () => {
  it("returns 'found' when exactly one desktop client exists", async () => {
    const home = await makeFakeHome({ "client_secret_abc.json": desktopSecret });
    assert.equal(await clientSecretPresence(home), "found");
  });

  it("returns 'missing' when none exists — the ordinary, broker-served case", async () => {
    const home = await makeFakeHome();
    assert.equal(await clientSecretPresence(home), "missing");
  });

  it("returns 'missing' when only a web client is present", async () => {
    const home = await makeFakeHome({ "client_secret_web.json": webSecret });
    assert.equal(await clientSecretPresence(home), "missing");
  });

  it("returns 'ambiguous' for multiple desktop clients — a distinct state from 'missing'", async () => {
    const home = await makeFakeHome({ "client_secret_a.json": desktopSecret, "client_secret_b.json": desktopSecret });
    assert.equal(await clientSecretPresence(home), "ambiguous");
  });

  it("ignores non-matching files when counting", async () => {
    const home = await makeFakeHome({ "client_secret_a.json": desktopSecret, "unrelated.json": "{}" });
    assert.equal(await clientSecretPresence(home), "found");
  });
});

describe("loadClientSecret", () => {
  it("returns client_id and client_secret from the installed shape", async () => {
    const home = await makeFakeHome({ "client_secret_abc.json": desktopSecret });
    assert.deepEqual(await loadClientSecret(home), { client_id: "id-123", client_secret: "secret-456" });
  });

  it("reports no desktop client when only a web-app credential exists", async () => {
    const home = await makeFakeHome({ "client_secret_web.json": webSecret });
    await assert.rejects(loadClientSecret(home), /no desktop-app client_secret/);
  });

  it("reports no desktop client for an installed shape missing client_secret", async () => {
    const home = await makeFakeHome({ "client_secret_partial.json": JSON.stringify({ installed: { client_id: "only-id" } }) });
    await assert.rejects(loadClientSecret(home), /no desktop-app client_secret/);
  });

  it("reports no desktop client for malformed JSON", async () => {
    const home = await makeFakeHome({ "client_secret_broken.json": "{oops" });
    await assert.rejects(loadClientSecret(home), /no desktop-app client_secret/);
  });
});

describe("empty credential fields", () => {
  // These satisfy a typeof check but fail at Google with an opaque
  // invalid_client, so they must not be selectable as a client.
  it("does not count an installed shape with empty strings", async () => {
    const home = await makeFakeHome({ "client_secret_empty.json": JSON.stringify({ installed: { client_id: "", client_secret: "" } }) });
    assert.equal(await clientSecretPresence(home), "missing");
  });

  it("prefers a valid client over one with empty fields", async () => {
    const home = await makeFakeHome({
      "client_secret_a_empty.json": JSON.stringify({ installed: { client_id: "", client_secret: "" } }),
      "client_secret_b_valid.json": desktopSecret,
    });
    assert.equal(await clientSecretPresence(home), "found");
    assert.match(await findClientSecretPath(home), /client_secret_b_valid/);
  });
});
