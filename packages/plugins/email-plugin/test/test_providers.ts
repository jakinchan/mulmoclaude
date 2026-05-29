import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { providerPresetForEmail } from "../src/providers";

describe("providerPresetForEmail", () => {
  it("returns Gmail preset for @gmail.com (TLS 993 / 465)", () => {
    const preset = providerPresetForEmail("alice@gmail.com");
    assert.ok(preset);
    assert.equal(preset?.imap.host, "imap.gmail.com");
    assert.equal(preset?.imap.port, 993);
    assert.equal(preset?.imap.secure, true);
    assert.equal(preset?.smtp.host, "smtp.gmail.com");
    assert.equal(preset?.smtp.port, 465);
    assert.equal(preset?.smtp.secure, true);
  });

  it("aliases googlemail.com to the Gmail preset", () => {
    const preset = providerPresetForEmail("a@googlemail.com");
    assert.equal(preset?.imap.host, "imap.gmail.com");
  });

  it("returns iCloud STARTTLS-on-587 SMTP for @icloud.com", () => {
    const preset = providerPresetForEmail("user@icloud.com");
    assert.equal(preset?.smtp.host, "smtp.mail.me.com");
    assert.equal(preset?.smtp.port, 587);
    assert.equal(preset?.smtp.secure, false);
  });

  it("is case-insensitive on the domain part", () => {
    const lower = providerPresetForEmail("a@gmail.com");
    const upper = providerPresetForEmail("a@GMAIL.COM");
    assert.deepEqual(lower, upper);
  });

  it("returns null for unknown domains so callers fall back to user-supplied config", () => {
    assert.equal(providerPresetForEmail("a@example.com"), null);
    assert.equal(providerPresetForEmail("a@self-hosted.local"), null);
  });

  it("returns null for malformed addresses without @", () => {
    assert.equal(providerPresetForEmail("not-an-email"), null);
  });
});
