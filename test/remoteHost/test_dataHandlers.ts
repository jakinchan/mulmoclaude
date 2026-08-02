// Unit tests for the phase-2 remote-host data handlers: getCollection, getFeed
// (paginated records), listShortcuts, listFeeds. Engine/IO stubbed so the tests
// assert wiring, coercion, and pagination — not the real collection engine.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createGetCollection, type GetCollectionDeps } from "../../server/remoteHost/handlers/getCollection.js";
import { createGetFeed, type GetFeedDeps } from "../../server/remoteHost/handlers/getFeed.js";
import { createListShortcuts, type ListShortcutsDeps } from "../../server/remoteHost/handlers/listShortcuts.js";
import { createListSkills, type ListSkillsDeps } from "../../server/remoteHost/handlers/listSkills.js";
import { createListFeeds, type ListFeedsDeps } from "../../server/remoteHost/handlers/listFeeds.js";

const records = (count: number) => Array.from({ length: count }, (_unused, index) => ({ id: `r${index}` }));

const collectionDeps = (all: { id: string }[]): GetCollectionDeps => ({
  loadCollection: (async (slug: string) =>
    slug === "missing"
      ? null
      : {
          slug,
          dataDir: `/d/${slug}`,
          schema: { primaryKey: "id", fields: { id: { type: "string" }, won: { type: "number" }, points: { type: "derived", formula: "won * 3" } } },
        }) as unknown as GetCollectionDeps["loadCollection"],
  listRecords: (async () => all) as unknown as GetCollectionDeps["listRecords"],
  toDetail: ((collection: { slug: string; schema: unknown }) => ({
    slug: collection.slug,
    title: collection.slug,
    icon: "x",
    source: "preset",
    schema: collection.schema,
  })) as unknown as GetCollectionDeps["toDetail"],
});

describe("createGetCollection", () => {
  it("returns a page of records + detail + total", async () => {
    const handler = createGetCollection(collectionDeps(records(5)));
    const result = (await handler({ slug: "clients", offset: 1, limit: 2 })) as {
      collection: { slug: string };
      items: { id: string }[];
      total: number;
      offset: number;
      limit: number;
    };
    assert.equal(result.total, 5);
    assert.deepEqual(result.items, [{ id: "r1" }, { id: "r2" }]);
    assert.equal(result.offset, 1);
    assert.equal(result.limit, 2);
    assert.equal(result.collection.slug, "clients");
  });

  it("resolves record-local derived formulas before paging", async () => {
    const handler = createGetCollection(collectionDeps([{ id: "r0", won: 2 } as unknown as { id: string }]));
    const result = (await handler({ slug: "clients" })) as { items: { id: string; points?: number }[] };
    assert.equal(result.items[0].points, 6);
  });

  it("throws when the collection is not found", async () => {
    const handler = createGetCollection(collectionDeps(records(3)));
    await assert.rejects(async () => {
      await handler({ slug: "missing" });
    }, /collection 'missing' not found/);
  });

  it("clamps a runaway limit and a negative offset, defaults a bad limit", async () => {
    const handler = createGetCollection(collectionDeps(records(500)));
    const huge = (await handler({ slug: "x", limit: 100000 })) as { limit: number };
    assert.equal(huge.limit, 200); // MAX_LIMIT
    const neg = (await handler({ slug: "x", offset: -5, limit: 0 })) as { offset: number; limit: number };
    assert.equal(neg.offset, 0);
    assert.equal(neg.limit, 50); // DEFAULT_LIMIT
  });

  // The page used to be asserted into JsonObject (#2692), so a record value the
  // channel cannot carry reached Firestore as a mangled write. Walking it means
  // the command doc gets an error naming the property instead.
  it("names the property when a record holds something JSON cannot carry", async () => {
    const handler = createGetCollection(collectionDeps([{ id: "r0", size: Number.NaN } as unknown as { id: string }]));
    await assert.rejects(async () => {
      await handler({ slug: "clients" });
    }, /payload\.items\[0\]\.size is NaN, which JSON cannot represent/);
  });

  // A Date is the case JSON.stringify handles for free and a hand-walk would
  // flatten to {}: it must serialise, not throw and not vanish.
  it("keeps a Date in a record as its ISO string", async () => {
    const seenAt = new Date("2026-01-02T03:04:05.000Z");
    const handler = createGetCollection(collectionDeps([{ id: "r0", seenAt } as unknown as { id: string }]));
    const result = (await handler({ slug: "clients" })) as { items: { seenAt: string }[] };
    assert.equal(result.items[0].seenAt, seenAt.toISOString());
  });
});

describe("createGetFeed", () => {
  const feedDeps = (all: { id: string }[]): GetFeedDeps => ({
    listFeeds: (async () => [{ slug: "news", dataDir: "/f/news", schema: {} }]) as unknown as GetFeedDeps["listFeeds"],
    listRecords: (async () => all) as unknown as GetFeedDeps["listRecords"],
    toDetail: ((feed: { slug: string }) => ({
      slug: feed.slug,
      title: feed.slug,
      icon: "rss",
      source: "feed",
      schema: {},
    })) as unknown as GetFeedDeps["toDetail"],
    workspaceRoot: "/ws",
  });

  it("returns a page of a feed's records via the registry", async () => {
    const handler = createGetFeed(feedDeps(records(4)));
    const result = (await handler({ slug: "news", offset: 0, limit: 3 })) as { items: unknown[]; total: number; collection: { slug: string } };
    assert.equal(result.total, 4);
    assert.equal(result.items.length, 3);
    assert.equal(result.collection.slug, "news");
  });

  it("throws when the feed slug is not in the registry", async () => {
    const handler = createGetFeed(feedDeps(records(2)));
    await assert.rejects(async () => {
      await handler({ slug: "ghost" });
    }, /feed 'ghost' not found/);
  });
});

describe("createListShortcuts", () => {
  it("returns the pinned shortcuts", async () => {
    const read = (async () => [{ kind: "collection", slug: "clients", title: "Clients", icon: "people" }]) as unknown as ListShortcutsDeps["read"];
    const handler = createListShortcuts({ read });
    assert.deepEqual(await handler({}), { shortcuts: [{ kind: "collection", slug: "clients", title: "Clients", icon: "people" }] });
  });
});

describe("createListSkills", () => {
  const skillsDep = (names: string[]): ListSkillsDeps["discoverSkills"] =>
    (async () => names.map((name) => ({ name, description: "d", source: "user" }))) as unknown as ListSkillsDeps["discoverSkills"];
  const collectionsDep = (entries: { slug: string; source: string }[]): ListSkillsDeps["discoverCollections"] =>
    (async () => entries) as unknown as ListSkillsDeps["discoverCollections"];

  it("returns just the skill ids as a flat string[]", async () => {
    const handler = createListSkills({
      discoverSkills: skillsDep(["deep-research", "precommit"]),
      discoverCollections: collectionsDep([]),
      workspaceRoot: "/ws",
    });
    assert.deepEqual(await handler({}), { skills: ["deep-research", "precommit"] });
  });

  it("excludes collection skills (skills whose id is a user/project collection slug)", async () => {
    const handler = createListSkills({
      discoverSkills: skillsDep(["deep-research", "clients", "invoices"]),
      discoverCollections: collectionsDep([
        { slug: "clients", source: "project" },
        { slug: "invoices", source: "user" },
      ]),
      workspaceRoot: "/ws",
    });
    assert.deepEqual(await handler({}), { skills: ["deep-research"] });
  });

  it("does not exclude a skill that merely shares a slug with a feed", async () => {
    const handler = createListSkills({
      discoverSkills: skillsDep(["news"]),
      discoverCollections: collectionsDep([{ slug: "news", source: "feed" }]),
      workspaceRoot: "/ws",
    });
    assert.deepEqual(await handler({}), { skills: ["news"] });
  });
});

describe("createListFeeds", () => {
  it("maps the feed registry + state into { feeds }", async () => {
    const deps: ListFeedsDeps = {
      listFeeds: (async () => [
        { slug: "news", schema: { title: "News", icon: "rss", ingest: { kind: "rss", schedule: "hourly" } } },
      ]) as unknown as ListFeedsDeps["listFeeds"],
      readFeedState: (async () => ({ lastFetchedAt: "2026-07-01T00:00:00Z" })) as unknown as ListFeedsDeps["readFeedState"],
      workspaceRoot: "/ws",
    };
    const handler = createListFeeds(deps);
    assert.deepEqual(await handler({}), {
      feeds: [{ slug: "news", title: "News", icon: "rss", kind: "rss", schedule: "hourly", lastFetchedAt: "2026-07-01T00:00:00Z" }],
    });
  });

  it("falls back to rss / on-demand when ingest fields are absent", async () => {
    const deps: ListFeedsDeps = {
      listFeeds: (async () => [{ slug: "x", schema: { title: "X", icon: "feed" } }]) as unknown as ListFeedsDeps["listFeeds"],
      readFeedState: (async () => ({ lastFetchedAt: null })) as unknown as ListFeedsDeps["readFeedState"],
      workspaceRoot: "/ws",
    };
    const result = (await createListFeeds(deps)({})) as { feeds: { kind: string; schedule: string }[] };
    assert.equal(result.feeds[0].kind, "rss");
    assert.equal(result.feeds[0].schedule, "on-demand");
  });
});
