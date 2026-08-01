import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { requestBodyRecord } from "../../server/utils/requestBody.js";

describe("requestBodyRecord", () => {
  it("passes a plain object through by reference", () => {
    const body = { op: "update", id: "a1" };
    assert.equal(requestBodyRecord(body), body);
  });

  it("reads a missing body as empty", () => {
    assert.deepEqual(requestBodyRecord(undefined), {});
    assert.deepEqual(requestBodyRecord(null), {});
  });

  it("reads a non-object JSON body as empty", () => {
    // `express.json()` accepts any JSON value, so a caller can POST a bare
    // array or string. Field lookups on those must not throw and must not
    // resolve to something the handler then trusts.
    assert.deepEqual(requestBodyRecord([1, 2, 3]), {});
    assert.deepEqual(requestBodyRecord("update"), {});
    assert.deepEqual(requestBodyRecord(42), {});
  });

  it("yields undefined for every field of an empty read", () => {
    assert.equal(requestBodyRecord([1, 2, 3]).items, undefined);
    assert.equal(requestBodyRecord("nope").viewId, undefined);
  });

  it("does not treat inherited properties as fields", () => {
    assert.equal(requestBodyRecord({}).toString, Object.prototype.toString);
    assert.equal(Object.hasOwn(requestBodyRecord({}), "toString"), false);
  });
});
