import "../../../server/workspace/collections/configure.js"; // configure @mulmoclaude/core/collection host binding for tests

// Validation for the `googleCalendar` block (#2095). A bad map is worse than a
// loud failure: the sync would write into a field nothing renders, or fight
// the primary key that keeps re-syncs idempotent. So these are schema errors.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CollectionSchemaZ } from "@mulmoclaude/core/collection/server";

const base = {
  title: "My schedule",
  icon: "calendar_month",
  dataPath: "data/collections/my-schedule/items",
  primaryKey: "gid",
  fields: {
    gid: { type: "string", label: "ID", primary: true, required: true },
    title: { type: "string", label: "Event" },
    on: { type: "datetime", label: "Start" },
    until: { type: "datetime", label: "End" },
  },
};

const withSync = (googleCalendar: unknown) => CollectionSchemaZ.safeParse({ ...base, googleCalendar });

describe("collection schema — googleCalendar block (#2095)", () => {
  it("accepts a schema without the block (back-compat)", () => {
    assert.equal(CollectionSchemaZ.safeParse(base).success, true);
  });

  it("accepts a valid block", () => {
    assert.equal(withSync({ calendarId: "primary", map: { title: "summary", on: "start", until: "end" } }).success, true);
  });

  it("accepts an omitted calendarId (defaults to the primary calendar)", () => {
    assert.equal(withSync({ map: { title: "summary" } }).success, true);
  });

  it("rejects a map key that names no declared field", () => {
    assert.equal(withSync({ map: { nope: "summary" } }).success, false);
  });

  it("rejects mapping onto the primaryKey — that always holds the event id", () => {
    assert.equal(withSync({ map: { gid: "summary" } }).success, false);
  });

  it("rejects an unknown Google source field", () => {
    assert.equal(withSync({ map: { title: "attendees" } }).success, false);
  });

  it("accepts the fields the pull gained in #2620", () => {
    assert.equal(withSync({ map: { title: "description" } }).success, true);
    assert.equal(withSync({ map: { title: "location" } }).success, true);
  });

  // Opt-in, and absent by default: an automatic push writes to a calendar other
  // people may read, so it is the user's decision (#2620).
  it("accepts autoPush and leaves it undefined when unstated", () => {
    assert.equal(withSync({ map: { title: "summary" }, autoPush: true }).success, true);
    const parsed = withSync({ map: { title: "summary" } });
    assert.equal(parsed.success && parsed.data.googleCalendar?.autoPush, undefined);
  });

  it("rejects a non-boolean autoPush rather than treating a typo as on", () => {
    assert.equal(withSync({ map: { title: "summary" }, autoPush: "yes" }).success, false);
  });

  // A computed field is derived at read time and never materialised, so a
  // sync writing into one would be silently discarded (Sourcery review on
  // #2184).
  it("rejects mapping onto a computed field", () => {
    const parsed = CollectionSchemaZ.safeParse({
      ...base,
      fields: { ...base.fields, span: { type: "formula", label: "Span", formula: "1" } },
      googleCalendar: { map: { span: "summary" } },
    });
    assert.equal(parsed.success, false);
  });

  it("rejects an empty calendarId (would build a malformed events URL)", () => {
    assert.equal(withSync({ calendarId: "   ", map: { title: "summary" } }).success, false);
  });

  // An empty map is silently useless rather than harmless: the sync writes a
  // record per event carrying only the event id, so the user sees empty rows
  // and no error anywhere (#2188).
  it("rejects an empty map", () => {
    assert.equal(withSync({ map: {} }).success, false);
  });

  it("rejects a missing map outright", () => {
    assert.equal(withSync({ calendarId: "primary" }).success, false);
  });

  it("rejects the block on a read-only dataSource collection", () => {
    const parsed = CollectionSchemaZ.safeParse({
      title: "CSV backed",
      icon: "table",
      dataSource: { type: "csv", path: "data/x.csv" },
      primaryKey: "gid",
      fields: { gid: { type: "string", label: "ID", primary: true, required: true }, title: { type: "string", label: "Event" } },
      googleCalendar: { map: { title: "summary" } },
    });
    assert.equal(parsed.success, false);
  });
});
