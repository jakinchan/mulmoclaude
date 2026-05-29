// Unit tests for the pure `when`-predicate visibility helpers
// (src/utils/collections/actionVisible.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { actionVisible, fieldVisible } from "../../../src/utils/collections/actionVisible.js";

describe("actionVisible", () => {
  it("is always visible when no `when` predicate is set", () => {
    assert.equal(actionVisible({}, {}), true);
    assert.equal(actionVisible({}, { status: "anything" }), true);
  });

  it("shows when the field value is in the allowed set", () => {
    const action = { when: { field: "status", in: ["sent", "paid"] } };
    assert.equal(actionVisible(action, { status: "sent" }), true);
    assert.equal(actionVisible(action, { status: "paid" }), true);
  });

  it("hides when the field value is not in the allowed set", () => {
    const action = { when: { field: "status", in: ["paid"] } };
    assert.equal(actionVisible(action, { status: "sent" }), false);
    assert.equal(actionVisible(action, { status: "draft" }), false);
  });

  it("hides when the gating field is missing or null", () => {
    const action = { when: { field: "status", in: ["sent"] } };
    assert.equal(actionVisible(action, {}), false);
    assert.equal(actionVisible(action, { status: undefined }), false);
    assert.equal(actionVisible(action, { status: null }), false);
  });

  it("compares against the stringified value (non-string fields)", () => {
    const action = { when: { field: "level", in: ["1", "2"] } };
    assert.equal(actionVisible(action, { level: 1 }), true);
    assert.equal(actionVisible(action, { level: 3 }), false);
    assert.equal(actionVisible({ when: { field: "active", in: ["true"] } }, { active: true }), true);
  });
});

describe("fieldVisible", () => {
  it("is always visible when the field has no `when` predicate", () => {
    assert.equal(fieldVisible({}, {}), true);
    assert.equal(fieldVisible({}, { visited: false }), true);
  });

  it("shows a gated field only when the gating value matches (restaurant rating case)", () => {
    const rating = { when: { field: "visited", in: ["true"] } };
    // `visited` true → rating shown.
    assert.equal(fieldVisible(rating, { visited: true }), true);
    // `visited` false → rating hidden.
    assert.equal(fieldVisible(rating, { visited: false }), false);
    // `visited` omitted (boolean omission semantics) → rating hidden.
    assert.equal(fieldVisible(rating, {}), false);
  });

  it("gates on an enum value just as well as a boolean", () => {
    const field = { when: { field: "status", in: ["active", "trial"] } };
    assert.equal(fieldVisible(field, { status: "active" }), true);
    assert.equal(fieldVisible(field, { status: "trial" }), true);
    assert.equal(fieldVisible(field, { status: "cancelled" }), false);
  });
});
