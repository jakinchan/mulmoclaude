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

  it("leaves mistyped fields undefined so the view keeps its default", () => {
    const parsed = extractWikiData({ data: { action: 1, title: null, content: [], pageExists: "yes" } });
    assert.deepEqual(parsed, { action: undefined, title: undefined, content: undefined, pageEntries: undefined, pageExists: undefined });
  });

  it("drops the whole page list when one row is malformed", () => {
    const parsed = extractWikiData({ data: { pageEntries: [pageEntry, { slug: "no-title" }] } });
    assert.equal(parsed?.pageEntries, undefined);
  });

  it("returns null when there is no data envelope", () => {
    assert.equal(extractWikiData(null), null);
    assert.equal(extractWikiData({}), null);
    assert.equal(extractWikiData({ data: "index" }), null);
    assert.equal(extractWikiData([{ data: {} }]), null);
  });
});
