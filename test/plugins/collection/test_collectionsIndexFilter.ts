// Unit tests for the collections-index narrowing
// (packages/plugins/collection-plugin/src/vue/collectionsIndexFilter.ts):
// the Editable/Data chip facet AND the search box, over the summary list the
// index renders.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CollectionSummary } from "@mulmoclaude/core/collection";
import { collectionMatchesQuery, filterIndexCollections } from "../../../packages/plugins/collection-plugin/src/vue/collectionsIndexFilter";

const summary = (slug: string, title: string, extra: Partial<CollectionSummary> = {}): CollectionSummary => ({
  slug,
  title,
  icon: "list",
  source: "project",
  ...extra,
});

const COLLECTIONS: CollectionSummary[] = [
  summary("tasks", "Tasks"),
  summary("task-templates", "Task Templates"),
  summary("clients", "顧客"),
  summary("stock-quotes", "Stock Quotes", { readonly: true }),
];

const slugsOf = (collections: CollectionSummary[]): string[] => collections.map((collection) => collection.slug);

describe("collectionMatchesQuery", () => {
  it("matches a substring of the title or the slug, case-insensitively", () => {
    assert.equal(collectionMatchesQuery(summary("stock-quotes", "Stock Quotes"), "quot"), true);
    assert.equal(collectionMatchesQuery(summary("stock-quotes", "Stock Quotes"), "STOCK"), true);
    assert.equal(collectionMatchesQuery(summary("stock-quotes", "Stock Quotes"), "k-qu"), true);
    assert.equal(collectionMatchesQuery(summary("stock-quotes", "Stock Quotes"), "invoices"), false);
  });

  it("matches a non-ASCII title", () => {
    assert.equal(collectionMatchesQuery(summary("clients", "顧客"), "顧"), true);
  });

  // The card shows title + slug; source/readonly are rendered as a dot and a
  // badge, so typing their underlying values must not select rows.
  it("does not match the metadata behind the badges", () => {
    const readonlyProject = summary("stock-quotes", "Stock Quotes", { readonly: true });
    assert.equal(collectionMatchesQuery(readonlyProject, "project"), false);
    assert.equal(collectionMatchesQuery(readonlyProject, "true"), false);
    assert.equal(collectionMatchesQuery(readonlyProject, "list"), false);
  });
});

describe("filterIndexCollections", () => {
  it("returns everything for the all chip and an empty query", () => {
    assert.deepEqual(slugsOf(filterIndexCollections(COLLECTIONS, "all", "")), ["tasks", "task-templates", "clients", "stock-quotes"]);
  });

  it("keeps the chip facet: editable excludes read-only, data keeps only it", () => {
    assert.deepEqual(slugsOf(filterIndexCollections(COLLECTIONS, "editable", "")), ["tasks", "task-templates", "clients"]);
    assert.deepEqual(slugsOf(filterIndexCollections(COLLECTIONS, "data", "")), ["stock-quotes"]);
  });

  it("narrows by substring, matching every collection whose title or slug contains it", () => {
    assert.deepEqual(slugsOf(filterIndexCollections(COLLECTIONS, "all", "task")), ["tasks", "task-templates"]);
    assert.deepEqual(slugsOf(filterIndexCollections(COLLECTIONS, "all", "templates")), ["task-templates"]);
    assert.deepEqual(slugsOf(filterIndexCollections(COLLECTIONS, "all", "nothing")), []);
  });

  it("ANDs the chip with the query", () => {
    assert.deepEqual(slugsOf(filterIndexCollections(COLLECTIONS, "data", "stock")), ["stock-quotes"]);
    assert.deepEqual(slugsOf(filterIndexCollections(COLLECTIONS, "editable", "stock")), []);
  });

  // A trailing space is what a query looks like mid-typing; it must not empty
  // the grid the way a raw `includes(" ")` would.
  it("trims surrounding whitespace, and blank input is not a filter", () => {
    assert.deepEqual(slugsOf(filterIndexCollections(COLLECTIONS, "all", "  task ")), ["tasks", "task-templates"]);
    assert.deepEqual(slugsOf(filterIndexCollections(COLLECTIONS, "all", "   ")), ["tasks", "task-templates", "clients", "stock-quotes"]);
  });
});
