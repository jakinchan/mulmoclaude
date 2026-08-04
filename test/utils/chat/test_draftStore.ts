import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDraft, parseStoredDrafts, omitSession, serializeDrafts, setDraft, type DraftMap } from "../../../src/utils/chat/draftStore.js";

describe("setDraft", () => {
  it("stores the draft under its session id, leaving other sessions untouched", () => {
    const drafts = setDraft({ b: "other" }, "a", "hello");
    assert.deepEqual(drafts, { b: "other", a: "hello" });
  });

  it("keeps the text verbatim, including a trailing space (slash commands need it)", () => {
    assert.equal(getDraft(setDraft({}, "a", "/skill "), "a"), "/skill ");
  });

  it("removes the key when the draft is cleared, so no empty entry lingers", () => {
    assert.deepEqual(setDraft({ a: "hello", b: "other" }, "a", ""), { b: "other" });
  });

  it("removes the key for whitespace-only text", () => {
    assert.deepEqual(setDraft({ a: "hello" }, "a", "  \n "), {});
  });

  it("does not mutate the map it is given", () => {
    const before: DraftMap = { a: "hello" };
    setDraft(before, "b", "new");
    assert.deepEqual(before, { a: "hello" });
  });

  it("drops the least recently touched session once the cap is exceeded", () => {
    const filled = Array.from({ length: 25 }, (_, i) => `s${i}`).reduce<DraftMap>((map, sessionId) => setDraft(map, sessionId, `draft-${sessionId}`), {});
    assert.equal(Object.keys(filled).length, 20);
    assert.equal(getDraft(filled, "s0"), "");
    assert.equal(getDraft(filled, "s24"), "draft-s24");
  });

  it("refreshes a session's position when re-typed, so it survives the cap", () => {
    const seeded = Array.from({ length: 20 }, (_, i) => `s${i}`).reduce<DraftMap>((map, sessionId) => setDraft(map, sessionId, `draft-${sessionId}`), {});
    const touched = setDraft(seeded, "s0", "still writing");
    const evicting = setDraft(touched, "new", "newest");
    assert.equal(getDraft(evicting, "s0"), "still writing");
    assert.equal(getDraft(evicting, "s1"), "");
  });
});

describe("omitSession", () => {
  it("forgets one session and keeps the rest", () => {
    assert.deepEqual(omitSession({ a: "one", b: "two" }, "a"), { b: "two" });
  });

  it("is a no-op for an unknown session", () => {
    assert.deepEqual(omitSession({ a: "one" }, "missing"), { a: "one" });
  });

  it("works on any per-session map, e.g. the attachment lists", () => {
    assert.deepEqual(omitSession({ a: [{ name: "one.png" }], b: [{ name: "two.png" }] }, "a"), { b: [{ name: "two.png" }] });
  });
});

describe("serializeDrafts / parseStoredDrafts", () => {
  it("round-trips a map", () => {
    const drafts = { a: "hello", b: "line1\nline2" };
    assert.deepEqual(parseStoredDrafts(serializeDrafts(drafts)), drafts);
  });

  it("never persists the draft of an unidentified session", () => {
    assert.deepEqual(parseStoredDrafts(serializeDrafts({ "": "off-chat text", a: "hello" })), { a: "hello" });
  });

  it("reads missing storage as no drafts", () => {
    assert.deepEqual(parseStoredDrafts(null), {});
    assert.deepEqual(parseStoredDrafts(""), {});
  });

  it("reads corrupted or foreign storage as no drafts", () => {
    assert.deepEqual(parseStoredDrafts("{not json"), {});
    assert.deepEqual(parseStoredDrafts('["a","b"]'), {});
    assert.deepEqual(parseStoredDrafts("null"), {});
  });

  it("drops entries that are not usable drafts", () => {
    assert.deepEqual(parseStoredDrafts('{"a":"hello","b":42,"c":null,"d":"   ","":"x"}'), { a: "hello" });
  });
});
