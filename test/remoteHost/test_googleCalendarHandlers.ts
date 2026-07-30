// Unit tests for the google.calendar.* command handlers: param validation,
// clamping, and wiring — the Google engine is stubbed (no network, no token).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { JsonObject } from "../../server/remoteHost/commandChannel.js";
import {
  createGoogleCalendarColors,
  createGoogleCalendarCreateEvent,
  createGoogleCalendarDeleteEvent,
  createGoogleCalendarListCalendars,
  createGoogleCalendarListEvents,
  createGoogleCalendarUpdateEvent,
  type GoogleCalendarDeps,
} from "../../server/remoteHost/handlers/googleCalendar.js";
import {
  DEFAULT_LIST_MAX_RESULTS,
  MAX_LIST_RESULTS,
  type CalendarColors,
  type CalendarEventInput,
  type CalendarEventSummary,
  type CalendarSummary,
  type DeleteCalendarEventInput,
  type ListEventsInput,
  type UpdateCalendarEventInput,
} from "@mulmoclaude/core/google";

const sampleEvent: CalendarEventSummary = {
  id: "ev1",
  summary: "Standup",
  start: "2026-07-17T09:00:00+09:00",
  end: "2026-07-17T09:15:00+09:00",
  htmlLink: "https://calendar.google.com/event?eid=ev1",
  status: "confirmed",
  colorId: "7",
  description: "",
  location: "",
};

const sampleCalendar: CalendarSummary = {
  id: "team@group.calendar.google.com",
  summary: "Team",
  description: "",
  primary: false,
  accessRole: "reader",
  backgroundColor: "#16a765",
  foregroundColor: "#ffffff",
  colorId: "8",
  timeZone: "Asia/Tokyo",
};

const sampleColors: CalendarColors = {
  event: { "7": { background: "#5484ed", foreground: "#1d1d1d" } },
  calendar: { "8": { background: "#16a765", foreground: "#1d1d1d" } },
};

interface StubCalls {
  createInputs: CalendarEventInput[];
  updateInputs: UpdateCalendarEventInput[];
  deleteInputs: DeleteCalendarEventInput[];
  listInputs: ListEventsInput[];
  tokenRequests: number;
}

const stubDeps = (): { deps: GoogleCalendarDeps; calls: StubCalls } => {
  const calls: StubCalls = { createInputs: [], updateInputs: [], deleteInputs: [], listInputs: [], tokenRequests: 0 };
  const deps: GoogleCalendarDeps = {
    getAccessToken: async () => {
      calls.tokenRequests += 1;
      return "stub-access-token";
    },
    createEvent: async (_token, input) => {
      calls.createInputs.push(input);
      return sampleEvent;
    },
    updateEvent: async (_token, input) => {
      calls.updateInputs.push(input);
      return sampleEvent;
    },
    deleteEvent: async (_token, input) => {
      calls.deleteInputs.push(input);
    },
    listEvents: async (_token, input = {}) => {
      calls.listInputs.push(input);
      return [sampleEvent];
    },
    listCalendars: async () => [sampleCalendar],
    getColors: async () => sampleColors,
  };
  return { deps, calls };
};

describe("createGoogleCalendarCreateEvent", () => {
  const validParams = { summary: "Standup", start: "2026-07-17T09:00:00+09:00", end: "2026-07-17T09:15:00+09:00" };

  it("creates an event and returns it under { event }", async () => {
    const { deps, calls } = stubDeps();
    const result = await createGoogleCalendarCreateEvent(deps)({ ...validParams, description: "daily" });
    assert.deepEqual(result, { event: sampleEvent });
    assert.equal(calls.tokenRequests, 1);
    assert.deepEqual(calls.createInputs, [
      { summary: "Standup", startDateTime: validParams.start, endDateTime: validParams.end, description: "daily", calendarId: undefined, colorId: undefined },
    ]);
  });

  it("passes description as undefined when omitted", async () => {
    const { deps, calls } = stubDeps();
    await createGoogleCalendarCreateEvent(deps)({ ...validParams });
    assert.equal(calls.createInputs[0]?.description, undefined);
  });

  it("threads calendarId and colorId through to the engine", async () => {
    const { deps, calls } = stubDeps();
    await createGoogleCalendarCreateEvent(deps)({ ...validParams, calendarId: "team@group.calendar.google.com", colorId: "7" });
    assert.equal(calls.createInputs[0]?.calendarId, "team@group.calendar.google.com");
    assert.equal(calls.createInputs[0]?.colorId, "7");
  });

  it("rejects an empty calendarId", async () => {
    const { deps } = stubDeps();
    await assert.rejects(Promise.resolve(createGoogleCalendarCreateEvent(deps)({ ...validParams, calendarId: "  " })), /calendarId must be a non-empty string/);
  });

  for (const key of ["summary", "start", "end"] as const) {
    it(`rejects when ${key} is missing`, async () => {
      const { deps } = stubDeps();
      const params = Object.fromEntries(Object.entries(validParams).filter(([name]) => name !== key));
      await assert.rejects(Promise.resolve(createGoogleCalendarCreateEvent(deps)(params)), new RegExp(`${key} must be a non-empty string`));
    });
  }

  it("rejects an empty summary", async () => {
    const { deps } = stubDeps();
    await assert.rejects(Promise.resolve(createGoogleCalendarCreateEvent(deps)({ ...validParams, summary: "  " })), /summary must be a non-empty string/);
  });

  const badDateTimes: { given: string; label: string }[] = [
    { given: "not-a-date", label: "rejects a non-date start" },
    { given: "2026-07-17", label: "rejects a date-only start (Google would 400 on dateTime)" },
    { given: "2026-07-17T09:00:00", label: "rejects a start without a timezone offset" },
    { given: "2026-13-01T09:00:00Z", label: "rejects a well-shaped but impossible month" },
    { given: "2026-02-31T09:00:00Z", label: "rejects an overflowed day that Date would silently normalize" },
    { given: "2026-07-17T24:00:00Z", label: "rejects an out-of-range hour" },
    { given: "2026-07-17T09:00:00+99:99", label: "rejects an out-of-range timezone offset" },
  ];
  for (const { given, label } of badDateTimes) {
    it(label, async () => {
      const { deps } = stubDeps();
      await assert.rejects(
        Promise.resolve(createGoogleCalendarCreateEvent(deps)({ ...validParams, start: given })),
        /start must be an ISO 8601 date-time with a timezone offset/,
      );
    });
  }

  const goodDateTimes: { given: string; label: string }[] = [
    { given: "2026-07-17T09:00:00Z", label: "accepts a UTC (Z) start" },
    { given: "2026-07-17T09:00:00.500+09:00", label: "accepts fractional seconds with an offset" },
  ];
  for (const { given, label } of goodDateTimes) {
    it(label, async () => {
      const { deps, calls } = stubDeps();
      await createGoogleCalendarCreateEvent(deps)({ ...validParams, start: given });
      // `CalendarEventInput`'s span is a union since #2598 (the flat pair or a
      // structured one), so reading the flat field needs the narrowing.
      const [input] = calls.createInputs;
      assert.ok(input && "startDateTime" in input, "the remote-host handler passes the flat span");
      assert.equal(input.startDateTime, given);
    });
  }

  it("does not fetch a token when validation fails", async () => {
    const { deps, calls } = stubDeps();
    await assert.rejects(Promise.resolve(createGoogleCalendarCreateEvent(deps)({})));
    assert.equal(calls.tokenRequests, 0);
  });
});

describe("createGoogleCalendarUpdateEvent", () => {
  it("patches only the supplied fields and returns the event", async () => {
    const { deps, calls } = stubDeps();
    const result = await createGoogleCalendarUpdateEvent(deps)({ eventId: "ev1", summary: "Renamed" });
    assert.deepEqual(result, { event: sampleEvent });
    assert.equal(calls.tokenRequests, 1);
    assert.deepEqual(calls.updateInputs, [
      {
        eventId: "ev1",
        summary: "Renamed",
        startDateTime: undefined,
        endDateTime: undefined,
        description: undefined,
        calendarId: undefined,
        colorId: undefined,
      },
    ]);
  });

  // The whole point of the clearable helper: "" reaches the patch builder as a
  // clear, while omitting the key leaves the description untouched.
  it('forwards description "" as a clear, not as a missing field', async () => {
    const { deps, calls } = stubDeps();
    await createGoogleCalendarUpdateEvent(deps)({ eventId: "ev1", description: "" });
    assert.equal(calls.updateInputs[0]?.description, "");
  });

  it("leaves description undefined when the key is absent", async () => {
    const { deps, calls } = stubDeps();
    await createGoogleCalendarUpdateEvent(deps)({ eventId: "ev1", summary: "Renamed" });
    assert.equal(calls.updateInputs[0]?.description, undefined);
  });

  it("rejects an edit with no edited field, without calling the engine", async () => {
    const { deps, calls } = stubDeps();
    await assert.rejects(
      Promise.resolve(createGoogleCalendarUpdateEvent(deps)({ eventId: "ev1" })),
      /pass at least one field to change \(summary, start, end, description, colorId\)/,
    );
    assert.equal(calls.updateInputs.length, 0);
  });

  it("counts an empty-string description as an edit", async () => {
    const { deps, calls } = stubDeps();
    await createGoogleCalendarUpdateEvent(deps)({ eventId: "ev1", description: "" });
    assert.equal(calls.updateInputs.length, 1);
  });

  it("rejects a missing eventId", async () => {
    const { deps } = stubDeps();
    await assert.rejects(Promise.resolve(createGoogleCalendarUpdateEvent(deps)({ summary: "Renamed" })), /eventId must be a non-empty string/);
  });

  it("threads calendarId and colorId through to the engine", async () => {
    const { deps, calls } = stubDeps();
    await createGoogleCalendarUpdateEvent(deps)({ eventId: "ev1", colorId: "7", calendarId: "team@group.calendar.google.com" });
    assert.equal(calls.updateInputs[0]?.colorId, "7");
    assert.equal(calls.updateInputs[0]?.calendarId, "team@group.calendar.google.com");
  });

  for (const key of ["start", "end"] as const) {
    it(`rejects a ${key} without a timezone offset`, async () => {
      const { deps } = stubDeps();
      await assert.rejects(
        Promise.resolve(createGoogleCalendarUpdateEvent(deps)({ eventId: "ev1", [key]: "2026-07-17T09:00:00" })),
        new RegExp(`${key} must be an ISO 8601 date-time`),
      );
    });
  }
});

describe("createGoogleCalendarDeleteEvent", () => {
  it("deletes the event and echoes the id", async () => {
    const { deps, calls } = stubDeps();
    const result = await createGoogleCalendarDeleteEvent(deps)({ eventId: "ev1" });
    assert.deepEqual(result, { deleted: true, eventId: "ev1" });
    assert.equal(calls.tokenRequests, 1);
    assert.deepEqual(calls.deleteInputs, [{ eventId: "ev1", calendarId: undefined }]);
  });

  it("threads calendarId through to the engine", async () => {
    const { deps, calls } = stubDeps();
    await createGoogleCalendarDeleteEvent(deps)({ eventId: "ev1", calendarId: "team@group.calendar.google.com" });
    assert.equal(calls.deleteInputs[0]?.calendarId, "team@group.calendar.google.com");
  });

  it("rejects a missing eventId without calling the engine", async () => {
    const { deps, calls } = stubDeps();
    await assert.rejects(Promise.resolve(createGoogleCalendarDeleteEvent(deps)({})), /eventId must be a non-empty string/);
    assert.equal(calls.deleteInputs.length, 0);
  });

  it("rejects an empty calendarId", async () => {
    const { deps } = stubDeps();
    await assert.rejects(Promise.resolve(createGoogleCalendarDeleteEvent(deps)({ eventId: "ev1", calendarId: "  " })), /calendarId must be a non-empty string/);
  });
});

describe("createGoogleCalendarListEvents", () => {
  it("lists events with defaults when no params are given", async () => {
    const { deps, calls } = stubDeps();
    const result = await createGoogleCalendarListEvents(deps)({});
    assert.deepEqual(result, { events: [sampleEvent] });
    assert.deepEqual(calls.listInputs, [{ timeMin: undefined, maxResults: DEFAULT_LIST_MAX_RESULTS, calendarId: undefined }]);
  });

  it("passes a valid timeMin through", async () => {
    const { deps, calls } = stubDeps();
    await createGoogleCalendarListEvents(deps)({ timeMin: "2026-07-17T00:00:00Z" });
    assert.equal(calls.listInputs[0]?.timeMin, "2026-07-17T00:00:00Z");
  });

  it("targets a non-primary calendar via calendarId", async () => {
    const { deps, calls } = stubDeps();
    await createGoogleCalendarListEvents(deps)({ calendarId: "team@group.calendar.google.com" });
    assert.equal(calls.listInputs[0]?.calendarId, "team@group.calendar.google.com");
  });

  it("trims a whitespace-padded calendarId before it reaches the engine", async () => {
    const { deps, calls } = stubDeps();
    await createGoogleCalendarListEvents(deps)({ calendarId: "  team@group.calendar.google.com  " });
    assert.equal(calls.listInputs[0]?.calendarId, "team@group.calendar.google.com");
  });

  it("rejects a malformed timeMin", async () => {
    const { deps } = stubDeps();
    await assert.rejects(
      Promise.resolve(createGoogleCalendarListEvents(deps)({ timeMin: "yesterday-ish" })),
      /timeMin must be an ISO 8601 date-time with a timezone offset/,
    );
  });

  it("rejects a date-only timeMin", async () => {
    const { deps } = stubDeps();
    await assert.rejects(
      Promise.resolve(createGoogleCalendarListEvents(deps)({ timeMin: "2026-07-17" })),
      /timeMin must be an ISO 8601 date-time with a timezone offset/,
    );
  });

  it("rejects a non-string timeMin", async () => {
    const { deps } = stubDeps();
    await assert.rejects(
      Promise.resolve(createGoogleCalendarListEvents(deps)({ timeMin: 12345 })),
      /timeMin must be an ISO 8601 date-time with a timezone offset/,
    );
  });

  const clampCases: { given: number | string | undefined; expected: number; label: string }[] = [
    { given: 5, expected: 5, label: "keeps an in-range maxResults" },
    { given: 1, expected: 1, label: "keeps the lower bound" },
    { given: 0, expected: 1, label: "raises 0 to the lower bound" },
    { given: -3, expected: 1, label: "raises negatives to the lower bound" },
    { given: MAX_LIST_RESULTS + 100, expected: MAX_LIST_RESULTS, label: "caps oversized maxResults" },
    { given: 2.5, expected: DEFAULT_LIST_MAX_RESULTS, label: "falls back to default for non-integers" },
    { given: "20", expected: DEFAULT_LIST_MAX_RESULTS, label: "falls back to default for strings" },
    { given: undefined, expected: DEFAULT_LIST_MAX_RESULTS, label: "falls back to default when absent" },
  ];
  for (const { given, expected, label } of clampCases) {
    it(label, async () => {
      const { deps, calls } = stubDeps();
      const params: JsonObject = given === undefined ? {} : { maxResults: given };
      await createGoogleCalendarListEvents(deps)(params);
      assert.equal(calls.listInputs[0]?.maxResults, expected);
    });
  }
});

describe("createGoogleCalendarListCalendars", () => {
  it("returns the calendars under { calendars }", async () => {
    const { deps, calls } = stubDeps();
    const result = await createGoogleCalendarListCalendars(deps)({});
    assert.deepEqual(result, { calendars: [sampleCalendar] });
    assert.equal(calls.tokenRequests, 1);
  });
});

describe("createGoogleCalendarColors", () => {
  it("returns the event/calendar palettes under { colors }", async () => {
    const { deps, calls } = stubDeps();
    const result = await createGoogleCalendarColors(deps)({});
    assert.deepEqual(result, { colors: sampleColors });
    assert.equal(calls.tokenRequests, 1);
  });
});
