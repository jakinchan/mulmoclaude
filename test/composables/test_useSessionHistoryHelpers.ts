import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBookmarkFlag } from "../../src/composables/useSessionHistory.helpers.ts";
import type { SessionSummary } from "../../src/types/session.ts";

function session(sessionId: string, isBookmarked?: boolean): SessionSummary {
  return { id: sessionId, roleId: "r", startedAt: "s", updatedAt: "u", preview: "p", ...(isBookmarked === undefined ? {} : { isBookmarked }) };
}

describe("applyBookmarkFlag", () => {
  it("sets isBookmarked=true on the matching session", () => {
    const result = applyBookmarkFlag([session("a"), session("b")], "b", true);
    const [, matched] = result;
    assert.ok(matched);
    assert.equal(matched.isBookmarked, true);
  });

  it("sets isBookmarked=false on the matching session", () => {
    const result = applyBookmarkFlag([session("a", true)], "a", false);
    const [matched] = result;
    assert.ok(matched);
    assert.equal(matched.isBookmarked, false);
  });

  it("leaves non-matching sessions unchanged", () => {
    const result = applyBookmarkFlag([session("a", true), session("b", false)], "b", true);
    const [untouched, matched] = result;
    assert.ok(untouched);
    assert.ok(matched);
    assert.equal(untouched.isBookmarked, true);
    assert.equal(matched.isBookmarked, true);
  });

  it("returns an all-unchanged copy when no id matches", () => {
    const input = [session("a", false), session("b", true)];
    const result = applyBookmarkFlag(input, "missing", true);
    assert.deepEqual(result, input);
  });

  it("returns an empty array for an empty list", () => {
    assert.deepEqual(applyBookmarkFlag([], "a", true), []);
  });

  it("does not mutate the input array or its matching element", () => {
    const original = session("a", false);
    const input = [original];
    const result = applyBookmarkFlag(input, "a", true);
    assert.equal(original.isBookmarked, false, "original element untouched");
    assert.notEqual(result[0], original, "matching element is a fresh object");
    assert.notEqual(result, input, "returns a new array");
  });

  it("returns non-matching elements by reference (only the match is cloned)", () => {
    const keep = session("a", false);
    const result = applyBookmarkFlag([keep, session("b")], "b", true);
    assert.equal(result[0], keep, "untouched element preserved by reference");
  });
});
