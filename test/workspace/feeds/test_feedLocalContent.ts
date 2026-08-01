// A feed record is written WHOLE (`writeItem`), so an ingest that wrote the
// retrieved item alone silently deleted every column the user had added beside
// it — and the maxItems prune then deleted the whole record once the article
// aged out. The Google Calendar pull learned the first half in #2620; the feeds
// ingest never did (#2696).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeIntoExisting } from "@mulmoclaude/core/collection";
import { hasLocalContent, ingestedFields } from "@mulmoclaude/core/feeds/server";

// An `rss` feed mapping three fields, keyed by `link`.
const MAP = { title: "title", published: "pubDate", summary: "description" };
const PRIMARY_KEY = "link";
const ingested = ingestedFields([], Object.keys(MAP), PRIMARY_KEY);

describe("ingestedFields (#2696)", () => {
  it("counts every mapped target plus the primary key", () => {
    assert.deepEqual([...ingested].sort(), ["link", "published", "summary", "title"]);
  });

  // `registerRetriever` lets a host add a retriever that returns fields the
  // declared map never names — the in-tree `rss`/`http-json` ones project
  // through `map`, but nothing forces that. Observing what actually arrived is
  // what stops those reading as the user's own columns and quietly disabling
  // the cap. (Caught by the existing engine test, whose fake retriever does
  // exactly this.)
  it("also counts fields the retriever returned but the map never named", () => {
    assert.equal(ingestedFields([{ link: "a", author: "someone" }], Object.keys(MAP), PRIMARY_KEY).has("author"), true);
  });

  // A run that fetched nothing has no keys to observe, so the declared map is
  // all that keeps the cap working through it.
  it("still knows the primary key when the feed maps nothing and fetched nothing", () => {
    assert.deepEqual([...ingestedFields([], [], "id")], ["id"]);
  });
});

describe("mergeIntoExisting on a feed record (#2696)", () => {
  const retrieved = { link: "https://example.com/1", title: "New title", published: "2026-08-01", summary: "fresh" };

  it("keeps a column the ingest does not produce", () => {
    const merged = mergeIntoExisting({ link: "https://example.com/1", title: "old", note: "read this on the train" }, retrieved);
    assert.equal(merged.note, "read this on the train");
  });

  it("still lets the feed win on the fields it maps", () => {
    const merged = mergeIntoExisting({ link: "https://example.com/1", title: "old", summary: "stale" }, retrieved);
    assert.equal(merged.title, "New title");
    assert.equal(merged.summary, "fresh");
  });

  it("writes the retrieved item as-is when the record is new", () => {
    assert.deepEqual(mergeIntoExisting(null, retrieved), retrieved);
  });
});

describe("hasLocalContent (#2696 what the maxItems prune must not delete)", () => {
  it("protects a record carrying a column the feed never wrote", () => {
    assert.equal(hasLocalContent({ link: "a", title: "t", note: "mine" }, ingested), true);
  });

  it("leaves an untouched record prunable", () => {
    assert.equal(hasLocalContent({ link: "a", title: "t", published: "2026-08-01" }, ingested), false);
  });

  // The trap this rule exists to avoid: saving a record through the UI can
  // write every declared field, empty ones included. Counting those as local
  // content would make every opened record un-prunable and the cap would
  // quietly stop working.
  it("does not count an empty column as local content", () => {
    assert.equal(hasLocalContent({ link: "a", title: "t", note: "" }, ingested), false);
    assert.equal(hasLocalContent({ link: "a", note: null }, ingested), false);
    assert.equal(hasLocalContent({ link: "a", note: undefined }, ingested), false);
  });

  // A feed is one-directional: the next refresh overwrites a mapped field by
  // design, so an edit there is transient and not a reason to keep the record
  // past the cap. The local COLUMN is the durable half.
  it("does not protect a record whose only change is to a mapped field", () => {
    assert.equal(hasLocalContent({ link: "a", title: "I retitled this" }, ingested), false);
  });

  it("counts a non-string local value", () => {
    assert.equal(hasLocalContent({ link: "a", rating: 5 }, ingested), true);
    assert.equal(hasLocalContent({ link: "a", tags: ["later"] }, ingested), true);
  });
});
