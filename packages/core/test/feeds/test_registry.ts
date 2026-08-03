import "./_setup.ts"; // configure @mulmoclaude/core collection + feeds hosts for tests
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

import path from "node:path";
import { listFeeds, removeFeed } from "../../src/feeds/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

// Feeds are now agent-authored files (no register tool): a
// feeds/<slug>/schema.json under the workspace. listFeeds() discovers
// them (filtered to source "feed"), with icon/dataPath defaulted.
function writeFeedSchema(root: string, slug: string, schema: Record<string, unknown>): void {
  const dir = path.join(root, "feeds", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "schema.json"), `${JSON.stringify(schema, null, 2)}\n`);
}

describe("listFeeds — discovery of agent-authored feed files", () => {
  it("discovers a feed and defaults icon + dataPath when omitted", async () => {
    const root = makeTempDir("feeds-discovery-");
    writeFeedSchema(root, "news", {
      title: "News",
      primaryKey: "id",
      fields: { id: { type: "string", label: "ID", primary: true }, title: { type: "string", label: "Title" } },
      ingest: { kind: "rss", url: "https://example.com/feed.xml", schedule: "hourly", idFrom: "guid", map: { id: "guid", title: "title" } },
    });
    const feed = (await listFeeds(root)).find((entry) => entry.slug === "news");
    assert.ok(feed, "feed discovered");
    assert.equal(feed.source, "feed");
    assert.equal(feed.schema.icon, "dynamic_feed", "icon defaulted");
    assert.equal(feed.schema.dataPath, "data/feeds/news", "dataPath defaulted");
  });

  it("keeps an explicit icon but FORCES dataPath to the feed namespace", async () => {
    const root = makeTempDir("feeds-discovery-");
    writeFeedSchema(root, "wx", {
      title: "Weather",
      icon: "cloud",
      dataPath: "data/wiki", // hostile / wrong — must be overridden, not trusted
      primaryKey: "id",
      fields: { id: { type: "string", label: "ID", primary: true } },
      ingest: { kind: "http-json", url: "https://example.com/x.json", schedule: "hourly", map: { id: "id" } },
    });
    const feed = (await listFeeds(root)).find((entry) => entry.slug === "wx");
    assert.ok(feed);
    assert.equal(feed.schema.icon, "cloud", "explicit icon kept");
    assert.equal(feed.schema.dataPath, "data/feeds/wx", "dataPath forced into the feed namespace");
  });

  it("excludes a feed-dir schema that has no `ingest` block", async () => {
    const root = makeTempDir("feeds-discovery-");
    writeFeedSchema(root, "noingest", {
      title: "No Ingest",
      primaryKey: "id",
      fields: { id: { type: "string", label: "ID", primary: true } },
      // no ingest → not a real feed; must not be listed
    });
    assert.ok(!(await listFeeds(root)).some((entry) => entry.slug === "noingest"));
  });

  it("removeFeed deletes both the feed registry dir and its records", async () => {
    const root = makeTempDir("feeds-discovery-");
    writeFeedSchema(root, "gone", {
      title: "Gone",
      primaryKey: "id",
      fields: { id: { type: "string", label: "ID", primary: true } },
      ingest: { kind: "rss", url: "https://example.com/feed.xml", schedule: "hourly", map: { id: "guid" } },
    });
    const recordsDir = path.join(root, "data", "feeds", "gone"); // default dataPath
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(path.join(recordsDir, "a.json"), JSON.stringify({ id: "a" }));

    const removed = await removeFeed(root, "gone");
    assert.equal(removed, true);
    assert.ok(!existsSync(path.join(root, "feeds", "gone")), "feed registry dir removed");
    assert.ok(!existsSync(recordsDir), "records dir removed");
  });

  it("removeFeed only touches data/feeds/<slug>, never another app's data", async () => {
    const root = makeTempDir("feeds-discovery-");
    // A feed that (maliciously) points dataPath at data/wiki — discovery
    // forces it back to data/feeds/<slug>, and removeFeed derives from slug.
    writeFeedSchema(root, "evil", {
      title: "Evil",
      dataPath: "data/wiki",
      primaryKey: "id",
      fields: { id: { type: "string", label: "ID", primary: true } },
      ingest: { kind: "rss", url: "https://example.com/feed.xml", schedule: "hourly", map: { id: "guid" } },
    });
    const wiki = path.join(root, "data", "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(path.join(wiki, "page.md"), "important");

    await removeFeed(root, "evil");
    assert.ok(existsSync(path.join(wiki, "page.md")), "unrelated data/wiki must be untouched");
  });

  it("skips a schema whose primaryKey field is not flagged primary", async () => {
    const root = makeTempDir("feeds-discovery-");
    writeFeedSchema(root, "broken", {
      title: "Broken",
      primaryKey: "id",
      fields: { id: { type: "string", label: "ID" } }, // missing primary: true
      ingest: { kind: "rss", url: "https://example.com/feed.xml", schedule: "hourly", map: { id: "guid" } },
    });
    assert.ok(!(await listFeeds(root)).some((entry) => entry.slug === "broken"));
  });
});
