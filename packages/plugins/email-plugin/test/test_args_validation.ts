import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Args } from "../src/args";

describe("manageEmail Args", () => {
  it("accepts a minimal list call with defaults", () => {
    const parsed = Args.safeParse({ kind: "list" });
    assert.equal(parsed.success, true);
    if (parsed.success && parsed.data.kind === "list") {
      assert.equal(parsed.data.mailbox, "INBOX");
      assert.equal(parsed.data.limit, 20);
    }
  });

  it("rejects out-of-range list limits", () => {
    assert.equal(Args.safeParse({ kind: "list", limit: 0 }).success, false);
    assert.equal(Args.safeParse({ kind: "list", limit: 201 }).success, false);
  });

  it("read requires a numeric UID", () => {
    assert.equal(Args.safeParse({ kind: "read" }).success, false);
    assert.equal(Args.safeParse({ kind: "read", uid: 42 }).success, true);
  });

  it("search rejects malformed ISO dates", () => {
    assert.equal(Args.safeParse({ kind: "search", since: "2026/01/02" }).success, false);
    assert.equal(Args.safeParse({ kind: "search", since: "2026-01-02" }).success, true);
  });

  it("send requires a recipient that looks like an email address", () => {
    const bad = Args.safeParse({ kind: "send", to: "not-an-email", subject: "hi", body: "x" });
    assert.equal(bad.success, false);
    const good = Args.safeParse({ kind: "send", to: "alice@example.com", subject: "hi", body: "x" });
    assert.equal(good.success, true);
  });

  it("send rejects empty subject", () => {
    assert.equal(Args.safeParse({ kind: "send", to: "a@b.com", subject: "", body: "x" }).success, false);
  });

  it("unknown kind is rejected (closed discriminated union)", () => {
    assert.equal(Args.safeParse({ kind: "delete" }).success, false);
  });
});
