import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { discoverCollections, storeFor } from "@mulmoclaude/core/collection/server";

import {
  calendarIdFrom,
  createCalendarCollectionWorkspace,
  liveCalendarBlocker,
  CALENDAR_FIELDS,
  WRITABLE_CALENDAR_ENV,
} from "../../e2e-live/fixtures/live-google.ts";

// The workspace `live-google.ts` seeds is a CONTRACT with the collection
// engine: a schema `discoverCollections` accepts, a `googleCalendar` block the
// push reads, and record files `storeFor(...).list()` returns. Nothing in the
// live spec (`e2e-live/tests/calendar-push.spec.ts`) can defend it, because
// without a Google grant every one of those tests skips — so a schema-validator
// change would break the fixture silently and only surface months later, in
// front of whoever finally has credentials.
//
// These run with no network and no grant.

const CALENDAR_ID = "e2e-live-contract@group.calendar.google.com";

const cleanups: (() => Promise<void>)[] = [];

const seedWorkspace = async () => {
  const workspace = await createCalendarCollectionWorkspace(CALENDAR_ID);
  cleanups.push(workspace.cleanup);
  return workspace;
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

describe("live-google fixture: the seeded calendar collection", () => {
  it("is discovered by the collection engine", async () => {
    const workspace = await seedWorkspace();
    const discovered = await discoverCollections({ workspaceRoot: workspace.root });
    const found = discovered.find((collection) => collection.slug === workspace.slug);
    // Discovery drops an invalid schema with a `log.warn` and returns nothing,
    // so "not found" is exactly how a validator change would present itself.
    assert.ok(found, `the seeded schema was rejected by discovery; slugs found: ${JSON.stringify(discovered.map((collection) => collection.slug))}`);
  });

  it("carries the googleCalendar block the push reads", async () => {
    const workspace = await seedWorkspace();
    const discovered = await discoverCollections({ workspaceRoot: workspace.root });
    const found = discovered.find((collection) => collection.slug === workspace.slug);
    assert.ok(found);
    assert.equal(found.schema.googleCalendar?.calendarId, CALENDAR_ID);
    // Every mapped source field must be one the push can actually write, or the
    // live spec would assert `updated: 1` on a field the push silently ignores.
    assert.deepEqual(found.schema.googleCalendar?.map, {
      [CALENDAR_FIELDS.summary]: "summary",
      [CALENDAR_FIELDS.start]: "start",
      [CALENDAR_FIELDS.end]: "end",
    });
    assert.equal(found.schema.primaryKey, CALENDAR_FIELDS.id);
  });

  it("stores a record where the collection store reads it back", async () => {
    const workspace = await seedWorkspace();
    const record = {
      [CALENDAR_FIELDS.id]: "deadbeef",
      [CALENDAR_FIELDS.summary]: "probe",
      [CALENDAR_FIELDS.start]: "2027-03-11T09:30",
      [CALENDAR_FIELDS.end]: "2027-03-11T10:15",
    };
    await workspace.putRecord("deadbeef", record);

    const discovered = await discoverCollections({ workspaceRoot: workspace.root });
    const found = discovered.find((collection) => collection.slug === workspace.slug);
    assert.ok(found);
    // The push lists records through this same seam, so a dataPath the schema
    // declares but the store cannot read would make every live test report
    // `created: 0` with no error.
    assert.deepEqual(await storeFor(found, { workspaceRoot: workspace.root }).list(), [record]);
  });

  it("gives each workspace its own slug so parallel workers cannot collide", async () => {
    const [first, second] = await Promise.all([seedWorkspace(), seedWorkspace()]);
    assert.notEqual(first.slug, second.slug);
    assert.notEqual(first.root, second.root);
  });
});

// `Reflect.deleteProperty` rather than `delete process.env[name]`: the lint
// rule bans deleting a computed key, and the env var name is a constant these
// tests share with the fixture rather than a literal to duplicate here.
const unsetEnv = (name: string): void => {
  Reflect.deleteProperty(process.env, name);
};

describe("live-google fixture: liveCalendarBlocker", () => {
  const original = process.env[WRITABLE_CALENDAR_ENV];
  afterEach(() => {
    if (original === undefined) unsetEnv(WRITABLE_CALENDAR_ENV);
    else process.env[WRITABLE_CALENDAR_ENV] = original;
  });

  it("blocks when no target calendar was supplied", async () => {
    unsetEnv(WRITABLE_CALENDAR_ENV);
    assert.match((await liveCalendarBlocker()) ?? "", /is unset/);
  });

  // The guard that matters: the live spec CREATES AND DELETES events, and
  // `primary` is the value the Google engine itself falls back to — so it is
  // both the easiest id to supply by mistake and the most destructive.
  it("refuses `primary` before it ever reads a token", async () => {
    process.env[WRITABLE_CALENDAR_ENV] = "primary";
    assert.match((await liveCalendarBlocker()) ?? "", /point it at a throwaway calendar/);
  });

  it("reads the env value with surrounding whitespace trimmed", () => {
    process.env[WRITABLE_CALENDAR_ENV] = "  padded@group.calendar.google.com  ";
    assert.equal(calendarIdFrom(WRITABLE_CALENDAR_ENV), "padded@group.calendar.google.com");
  });
});
