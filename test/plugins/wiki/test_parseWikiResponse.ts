// The wiki index / page views apply whatever `extractWikiData` returns, so a
// field it rejects is a field that silently resets to its default.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractWikiData } from "../../../src/plugins/wiki/parseWikiResponse.js";

const pageEntry = { title: "Home", slug: "home", description: "Landing page", tags: ["start"] };

describe("extractWikiData", () => {
  it("keeps the fields the views render", () => {
    const parsed = extractWikiData({ data: { action: "page", title: "Home", content: "# Home", pageEntries: [pageEntry], pageExists: true } });
    assert.deepEqual(parsed, { action: "page", title: "Home", content: "# Home", pageEntries: [pageEntry], pageExists: true });
  });

  it("defaults a missing tags list to empty rather than dropping the entry", () => {
    const parsed = extractWikiData({ data: { pageEntries: [{ title: "T", slug: "s", description: "d" }] } });
    assert.deepEqual(parsed?.pageEntries, [{ title: "T", slug: "s", description: "d", tags: [] }]);
  });

  it("leaves absent fields undefined so the view applies its own default", () => {
    assert.deepEqual(extractWikiData({ data: {} }), {
      action: undefined,
      title: undefined,
      content: undefined,
      pageEntries: undefined,
      pageExists: undefined,
    });
  });

  // A present-but-mistyped field means the payload isn't a wiki payload.
  // Handing back a partial object would let the views' `?? default` overwrite
  // good state with "Wiki" / "" / [], so the whole envelope is rejected and
  // `useFreshPluginData` skips `apply`.
  it("rejects the envelope when a present field has the wrong type", () => {
    assert.equal(extractWikiData({ data: { action: 1 } }), null);
    assert.equal(extractWikiData({ data: { title: null } }), null);
    assert.equal(extractWikiData({ data: { content: [] } }), null);
    assert.equal(extractWikiData({ data: { pageExists: "yes" } }), null);
  });

  it("rejects the envelope when one page row is malformed, so the index is kept", () => {
    assert.equal(extractWikiData({ data: { pageEntries: [pageEntry, { slug: "no-title" }] } }), null);
    assert.equal(extractWikiData({ data: { pageEntries: "home" } }), null);
  });

  it("returns null when there is no data envelope", () => {
    assert.equal(extractWikiData(null), null);
    assert.equal(extractWikiData({}), null);
    assert.equal(extractWikiData({ data: "index" }), null);
    assert.equal(extractWikiData([{ data: {} }]), null);
  });
});
