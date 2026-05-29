import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { configAbsolutePath, missingConfigResponse, resolveConfig, serverUnknownResponse } from "../src/config";

describe("configAbsolutePath", () => {
  it("encodes the package scope so it sits under config/plugins/", () => {
    const path = configAbsolutePath();
    assert.ok(path.endsWith("/mulmoclaude/config/plugins/%40mulmoclaude%2Femail-plugin/config.json"), path);
    assert.ok(!path.includes("\\"), "must use forward slashes for Windows compatibility");
  });
});

describe("resolveConfig", () => {
  it("ok branch fills both imap+smtp from the Gmail preset when not user-overridden", () => {
    const res = resolveConfig({ email: "a@gmail.com", password: "abcd-efgh-ijkl-mnop" });
    assert.equal(res.kind, "ok");
    if (res.kind === "ok") {
      assert.equal(res.config.imap.host, "imap.gmail.com");
      assert.equal(res.config.smtp.host, "smtp.gmail.com");
    }
  });

  it("user-supplied imap overrides the preset", () => {
    const res = resolveConfig({
      email: "a@gmail.com",
      password: "x",
      imap: { host: "imap.custom.example", port: 1993, secure: true },
    });
    assert.equal(res.kind, "ok");
    if (res.kind === "ok") {
      assert.equal(res.config.imap.host, "imap.custom.example");
      assert.equal(res.config.imap.port, 1993);
      // smtp still comes from the gmail preset
      assert.equal(res.config.smtp.host, "smtp.gmail.com");
    }
  });

  it("unknown domain without explicit imap/smtp returns server_unknown", () => {
    const res = resolveConfig({ email: "a@self-hosted.local", password: "x" });
    assert.equal(res.kind, "server_unknown");
    if (res.kind === "server_unknown") assert.equal(res.email, "a@self-hosted.local");
  });

  it("unknown domain WITH explicit imap+smtp succeeds", () => {
    const res = resolveConfig({
      email: "a@self-hosted.local",
      password: "x",
      imap: { host: "mail.self-hosted.local", port: 993, secure: true },
      smtp: { host: "mail.self-hosted.local", port: 465, secure: true },
    });
    assert.equal(res.kind, "ok");
  });
});

describe("self-healing response shapes", () => {
  it("missingConfigResponse embeds path + JSON schema in instructions", () => {
    const res = missingConfigResponse();
    assert.ok(res.instructions.includes("config.json"));
    assert.ok(res.instructions.includes("password"));
    assert.ok(res.instructions.includes("App Password"));
  });

  it("serverUnknownResponse quotes the offending email in instructions", () => {
    const res = serverUnknownResponse("a@self-hosted.local");
    assert.ok(res.instructions.includes("a@self-hosted.local"));
    assert.ok(res.instructions.includes("imap"));
    assert.ok(res.instructions.includes("smtp"));
  });
});
