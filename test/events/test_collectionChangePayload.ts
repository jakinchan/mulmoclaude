// What a collection change carries OUT to browser subscribers.
//
// The payload is relayed into custom-view iframes, so this is a privacy
// boundary as well as a wire shape: no record bodies, and no root — an
// absolute path must not reach a subscriber. Pure, so it is tested without a
// pubsub instance.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toChannelPayload } from "../../server/events/collection-change.js";

describe("toChannelPayload", () => {
  it("carries only the keys the change actually had", () => {
    // deepEqual is deepSTRICTEqual: an own `ids: undefined` key would fail
    // this, which is the point — absent means absent.
    assert.deepEqual(toChannelPayload({ slug: "tasks" }), { slug: "tasks" });
    assert.deepEqual(toChannelPayload({ slug: "tasks", ids: ["t1"], op: "upsert" }), { slug: "tasks", ids: ["t1"], op: "upsert" });
  });

  it("passes the app through, so a subscriber can tell two shared collections apart", () => {
    assert.deepEqual(toChannelPayload({ slug: "tasks", aid: "salon" }), { slug: "tasks", aid: "salon" });
  });

  it("never relays a root", () => {
    // The channel payload reaches the browser and, through a view, an
    // LLM-authored iframe. An absolute root would publish the user's home
    // directory to it.
    const payload = toChannelPayload({ slug: "tasks", root: "/Users/someone/projects/secret" });
    assert.equal(Object.hasOwn(payload, "root"), false);
    assert.equal(JSON.stringify(payload).includes("/Users/"), false);
  });
});
