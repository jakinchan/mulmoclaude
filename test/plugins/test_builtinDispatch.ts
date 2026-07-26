// `describeKind` renders a rejected dispatch payload's `kind` for an error
// message. Its one hard requirement is that it NEVER throws: it runs only
// after a guard has already refused the payload, so the value is malformed by
// definition, and `payload.kind` on a `null` or a primitive would replace the
// caller's diagnostic with a TypeError.
//
// The declared handler parameter is `Record<string, unknown>` and the HTTP
// route coerces (`isRecord(req.body) ? req.body : {}`), so the non-object
// cases are unreachable through that path — they are covered because a direct
// caller (a test, another host wiring the registry itself) has no such
// guarantee.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeKind } from "../../server/plugins/builtin-dispatch.js";

describe("describeKind", () => {
  it("renders a present kind", () => {
    assert.equal(describeKind({ kind: "loadDoc" }), '"loadDoc"');
  });

  it("renders a missing kind without throwing", () => {
    assert.equal(describeKind({}), "undefined");
  });

  it("renders a non-string kind", () => {
    assert.equal(describeKind({ kind: 7 }), "7");
    assert.equal(describeKind({ kind: null }), "null");
  });

  // The cases that used to throw when the message interpolated `args.kind`
  // directly. A rejection path that throws is not a rejection path.
  it("never throws on null, undefined, or a primitive", () => {
    for (const value of [null, undefined, 7, "loadDoc", true]) {
      assert.doesNotThrow(() => describeKind(value), `describeKind(${JSON.stringify(value)}) must not throw`);
    }
  });

  it("returns something printable for each of those", () => {
    assert.equal(describeKind(null), "null");
    assert.equal(describeKind(undefined), "undefined");
    assert.equal(describeKind(7), "7");
    assert.equal(describeKind("loadDoc"), '"loadDoc"');
  });

  it("does not throw on an array", () => {
    assert.doesNotThrow(() => describeKind([]));
  });
});
