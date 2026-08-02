// Unit tests for the Calendar REST mapping helpers — pure functions only, no
// network. The fetch path itself is covered by fetchWithTimeout's own tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildEventPatch,
  calendarApiError,
  collectCalendarPages,
  toCalendarMeta,
  toCalendarSummary,
  toEventSummary,
  type CalendarListPage,
} from "@mulmoclaude/core/google";

const emptyEvent = { id: "", summary: "", start: "", end: "", htmlLink: "", status: "", colorId: "", description: "", location: "" };

describe("toEventSummary", () => {
  it("maps a timed event (dateTime) with its colour", () => {
    const summary = toEventSummary({
      id: "ev1",
      summary: "Standup",
      status: "confirmed",
      colorId: "7",
      htmlLink: "https://calendar.google.com/event?eid=ev1",
      start: { dateTime: "2026-07-17T09:00:00+09:00" },
      end: { dateTime: "2026-07-17T09:15:00+09:00" },
    });
    assert.deepEqual(summary, {
      id: "ev1",
      summary: "Standup",
      start: "2026-07-17T09:00:00+09:00",
      end: "2026-07-17T09:15:00+09:00",
      htmlLink: "https://calendar.google.com/event?eid=ev1",
      status: "confirmed",
      colorId: "7",
      description: "",
      location: "",
    });
  });

  // The body is Google's own limited HTML. Storing it verbatim is what lets a
  // mirrored event survive the round trip back to Google (#2620).
  it("keeps the description's markup byte-for-byte", () => {
    const body = '<b>Agenda</b><br><a href="https://example.test">notes</a>';
    const summary = toEventSummary({ id: "ev3", description: body, location: "Room 4" });
    assert.equal(summary.description, body);
    assert.equal(summary.location, "Room 4");
  });

  it("leaves colorId empty when the event inherits the calendar colour", () => {
    assert.equal(toEventSummary({ id: "ev2", start: { date: "2026-07-17" } }).colorId, "");
  });

  it("maps an all-day event (date)", () => {
    const summary = toEventSummary({ start: { date: "2026-07-17" }, end: { date: "2026-07-18" } });
    assert.equal(summary.start, "2026-07-17");
    assert.equal(summary.end, "2026-07-18");
  });

  it("prefers dateTime over date when both are present", () => {
    const summary = toEventSummary({ start: { dateTime: "2026-07-17T09:00:00Z", date: "2026-07-17" } });
    assert.equal(summary.start, "2026-07-17T09:00:00Z");
  });

  it("fills empty strings for missing fields", () => {
    assert.deepEqual(toEventSummary({}), emptyEvent);
  });

  it("tolerates a non-object payload", () => {
    assert.deepEqual(toEventSummary(null), emptyEvent);
  });

  it("ignores non-string field values", () => {
    const summary = toEventSummary({ id: 42, summary: ["x"], start: "not-an-object", colorId: 7 });
    assert.deepEqual(summary, emptyEvent);
  });
});

describe("toCalendarSummary", () => {
  it("maps a calendar-list entry with its colours", () => {
    const summary = toCalendarSummary({
      id: "team@group.calendar.google.com",
      summary: "Team",
      description: "shared team calendar",
      accessRole: "reader",
      backgroundColor: "#16a765",
      foregroundColor: "#ffffff",
      colorId: "8",
      timeZone: "Asia/Tokyo",
    });
    assert.deepEqual(summary, {
      id: "team@group.calendar.google.com",
      summary: "Team",
      description: "shared team calendar",
      primary: false,
      accessRole: "reader",
      backgroundColor: "#16a765",
      foregroundColor: "#ffffff",
      colorId: "8",
      // Carried since #2598: the zone a pushed offset-less dateTime is read in.
      timeZone: "Asia/Tokyo",
    });
  });

  it("marks the primary calendar only when primary === true", () => {
    assert.equal(toCalendarSummary({ id: "primary", primary: true }).primary, true);
    assert.equal(toCalendarSummary({ id: "other", primary: "true" }).primary, false);
    assert.equal(toCalendarSummary({ id: "none" }).primary, false);
  });

  it("fills empty strings for missing fields and tolerates a non-object payload", () => {
    const empty = { id: "", summary: "", description: "", primary: false, accessRole: "", backgroundColor: "", foregroundColor: "", colorId: "", timeZone: "" };
    assert.deepEqual(toCalendarSummary({}), empty);
    assert.deepEqual(toCalendarSummary(null), empty);
  });
});

describe("toCalendarMeta", () => {
  // What an unlisted calendar is judged on: the events.list envelope, since
  // `calendars.get` takes scopes this app never requests (#2735).
  it("reads the zone and the role off an events.list envelope", () => {
    const meta = toCalendarMeta({
      kind: "calendar#events",
      summary: "Shared",
      timeZone: "Asia/Tokyo",
      accessRole: "writer",
      items: [{ id: "ev1" }],
    });
    assert.deepEqual(meta, { timeZone: "Asia/Tokyo", accessRole: "writer" });
  });

  // `""` must stay distinguishable from a role Google DID report: the push
  // turns it into `null` (unknown) and falls through, where a wrong non-empty
  // value would refuse a calendar the user can write to.
  it("fills empty strings for missing fields and tolerates a non-object payload", () => {
    assert.deepEqual(toCalendarMeta({ items: [] }), { timeZone: "", accessRole: "" });
    assert.deepEqual(toCalendarMeta(null), { timeZone: "", accessRole: "" });
  });

  it("ignores non-string field values", () => {
    assert.deepEqual(toCalendarMeta({ timeZone: 9, accessRole: ["writer"] }), { timeZone: "", accessRole: "" });
  });
});

describe("collectCalendarPages", () => {
  it("returns a single page when there is no nextPageToken", async () => {
    const calendars = await collectCalendarPages(async () => ({ items: [{ id: "a" }, { id: "b" }] }));
    assert.deepEqual(
      calendars.map((cal) => cal.id),
      ["a", "b"],
    );
  });

  it("follows nextPageToken and concatenates every page in order", async () => {
    const pages: CalendarListPage[] = [{ items: [{ id: "a" }], nextPageToken: "p2" }, { items: [{ id: "b" }], nextPageToken: "p3" }, { items: [{ id: "c" }] }];
    const seenTokens: (string | undefined)[] = [];
    const calendars = await collectCalendarPages(async (pageToken) => {
      seenTokens.push(pageToken);
      return pages[seenTokens.length - 1];
    });
    assert.deepEqual(
      calendars.map((cal) => cal.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(seenTokens, [undefined, "p2", "p3"]);
  });

  it("stops at the page cap even if the API keeps returning a token (no infinite loop)", async () => {
    let calls = 0;
    const calendars = await collectCalendarPages(async () => {
      calls += 1;
      return { items: [{ id: `c${calls}` }], nextPageToken: "always" };
    }, 3);
    assert.equal(calls, 3);
    assert.equal(calendars.length, 3);
  });
});

describe("buildEventPatch (#2569)", () => {
  it("sends only what the caller asked to change", () => {
    assert.deepEqual(buildEventPatch({ eventId: "e1", summary: "Renamed" }), { summary: "Renamed" });
  });

  it("sends nothing when nothing changed — eventId and calendarId address, they do not edit", () => {
    assert.deepEqual(buildEventPatch({ eventId: "e1", calendarId: "team@group.calendar.google.com" }), {});
  });

  // The whole reason the builder can't use truthiness: "" is a request to
  // empty the body, and dropping it would silently ignore the edit.
  it('keeps description: "" — it clears the body', () => {
    assert.deepEqual(buildEventPatch({ eventId: "e1", description: "" }), { description: "" });
  });

  it('keeps location: "" for the same reason', () => {
    assert.deepEqual(buildEventPatch({ eventId: "e1", location: "" }), { location: "" });
  });

  it("leaves location alone when the caller never mentioned it", () => {
    assert.deepEqual(buildEventPatch({ eventId: "e1", summary: "x" }), { summary: "x" });
  });

  // Deliberate asymmetry with `description`: Calendar rejects colorId "" as a
  // bad palette id, and the arg layer already refuses it, so falsy means omit.
  it('drops colorId: "" rather than sending an invalid palette id', () => {
    assert.deepEqual(buildEventPatch({ eventId: "e1", summary: "x", colorId: "" }), { summary: "x" });
  });

  it("wraps the times the way the API expects", () => {
    assert.deepEqual(buildEventPatch({ eventId: "e1", startDateTime: "2026-07-17T09:00:00+09:00", endDateTime: "2026-07-17T10:00:00+09:00" }), {
      start: { dateTime: "2026-07-17T09:00:00+09:00" },
      end: { dateTime: "2026-07-17T10:00:00+09:00" },
    });
  });

  it("moves one end of the event without touching the other", () => {
    assert.deepEqual(buildEventPatch({ eventId: "e1", endDateTime: "2026-07-17T11:00:00+09:00" }), { end: { dateTime: "2026-07-17T11:00:00+09:00" } });
  });

  it("carries every field together", () => {
    const patch = buildEventPatch({
      eventId: "e1",
      summary: "S",
      description: "D",
      startDateTime: "2026-07-17T09:00:00Z",
      endDateTime: "2026-07-17T10:00:00Z",
      colorId: "7",
      calendarId: "ignored",
    });
    assert.deepEqual(Object.keys(patch).sort(), ["colorId", "description", "end", "start", "summary"]);
  });
});

describe("calendarApiError", () => {
  it("adds the enable-the-API hint on 403", () => {
    assert.match(calendarApiError(403, "").message, /is the Google Calendar API enabled/);
  });

  it("has no hint on other statuses", () => {
    assert.doesNotMatch(calendarApiError(500, "").message, /enabled/);
    assert.match(calendarApiError(500, "").message, /HTTP 500/);
  });

  it("includes and truncates a long error body", () => {
    const { message } = calendarApiError(400, "x".repeat(1000));
    assert.ok(message.length < 500, `message unexpectedly long: ${message.length}`);
    assert.match(message, /x{10}/);
  });

  it("omits the body separator when the body is empty", () => {
    assert.equal(calendarApiError(401, "").message, "Google Calendar API: HTTP 401");
  });
});
