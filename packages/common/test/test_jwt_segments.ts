import { test } from "node:test";
import assert from "node:assert/strict";

import { splitJwtSegments } from "../src/index.ts";

test("splitJwtSegments: splits a three-segment compact serialization", () => {
  assert.deepEqual(splitJwtSegments("aaa.bbb.ccc"), {
    headerSegment: "aaa",
    payloadSegment: "bbb",
    signatureSegment: "ccc",
  });
});

test("splitJwtSegments: rejects fewer than three segments", () => {
  assert.equal(splitJwtSegments(""), null);
  assert.equal(splitJwtSegments("aaa"), null);
  assert.equal(splitJwtSegments("aaa.bbb"), null);
});

test("splitJwtSegments: rejects more than three segments", () => {
  // The hardening this guard exists for: an attacker appending `.junk`, or a
  // five-segment JWE, must be refused outright — never parsed from its first
  // three segments, which would let the signed input disagree with the token.
  assert.equal(splitJwtSegments("aaa.bbb.ccc.junk"), null);
  assert.equal(splitJwtSegments("aaa.bbb.ccc.ddd.eee"), null);
});

test("splitJwtSegments: empty segments are structurally valid (decode rejects them later)", () => {
  // `"".split(".")` on `"..".split(".")` yields three empty strings — well-formed
  // as a shape. Callers still fail on the base64/JSON decode, so this stays a
  // pure structure check rather than a content check.
  assert.deepEqual(splitJwtSegments(".."), {
    headerSegment: "",
    payloadSegment: "",
    signatureSegment: "",
  });
});

test("splitJwtSegments: a trailing dot counts as a fourth (empty) segment", () => {
  assert.equal(splitJwtSegments("aaa.bbb.ccc."), null);
});
