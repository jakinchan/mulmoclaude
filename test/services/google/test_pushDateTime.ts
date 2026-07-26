// Unit tests for the push-side date-time rebuild (#2598).
//
// This is the one place where the pull's deliberate data loss has to be undone:
// `toCollectionDateTime` drops the zone offset and flattens an all-day date into
// `…T00:00`, so a naive inverse would silently retime every event it touches and
// turn every all-day event into a midnight appointment. The baseline Google gave
// us is what makes the rebuild exact, and these tests pin that it is used.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toCollectionDateTime, toGoogleEventTime, zoneSuffixOf } from "@mulmoclaude/core/google";

const TOKYO = "Asia/Tokyo";

describe("zoneSuffixOf", () => {
  it("reads a +09:00 offset", () => {
    assert.equal(zoneSuffixOf("2026-07-19T09:00:00+09:00"), "+09:00");
  });

  it("reads a Z designator", () => {
    assert.equal(zoneSuffixOf("2026-07-19T00:00:00Z"), "Z");
  });

  it("reads a compact -0500 offset", () => {
    assert.equal(zoneSuffixOf("2026-07-19T09:00:00-0500"), "-0500");
  });

  it("is null for an all-day date and for no baseline", () => {
    assert.equal(zoneSuffixOf("2026-07-19"), null);
    assert.equal(zoneSuffixOf(undefined), null);
  });
});

describe("toGoogleEventTime — a timed event keeps its original zone", () => {
  it("re-attaches the baseline's offset to an edited clock", () => {
    const time = toGoogleEventTime("2026-07-19T10:30", "2026-07-19T09:00:00+09:00", TOKYO);
    assert.deepEqual(time, { dateTime: "2026-07-19T10:30:00+09:00" });
  });

  it("re-attaches Z rather than assuming the calendar's zone", () => {
    const time = toGoogleEventTime("2026-07-19T10:30", "2026-07-19T09:00:00Z", TOKYO);
    assert.deepEqual(time, { dateTime: "2026-07-19T10:30:00Z" });
  });

  it("keeps seconds the stored value already carries", () => {
    const time = toGoogleEventTime("2026-07-19T10:30:45", "2026-07-19T09:00:00+09:00", TOKYO);
    assert.deepEqual(time, { dateTime: "2026-07-19T10:30:45+09:00" });
  });
});

describe("toGoogleEventTime — an all-day event stays all-day", () => {
  it("sends `date`, not a midnight `dateTime`, when the baseline was all-day", () => {
    const time = toGoogleEventTime("2026-07-19T00:00", "2026-07-19", TOKYO);
    assert.deepEqual(time, { date: "2026-07-19" });
  });

  it("moves the day without converting the event to a timed one", () => {
    const time = toGoogleEventTime("2026-07-20T00:00", "2026-07-19", TOKYO);
    assert.deepEqual(time, { date: "2026-07-20" });
  });

  // Google's all-day `end` is exclusive, so a record's stored end is the day
  // AFTER the last day. Adjusting it here would shorten every all-day event.
  it("passes an exclusive end date straight through", () => {
    const time = toGoogleEventTime("2026-07-20T00:00", "2026-07-20", TOKYO);
    assert.deepEqual(time, { date: "2026-07-20" });
  });

  it("ignores a clock the user typed into an all-day record's field", () => {
    const time = toGoogleEventTime("2026-07-19T14:00", "2026-07-19", TOKYO);
    assert.deepEqual(time, { date: "2026-07-19" });
  });
});

describe("toGoogleEventTime — no baseline (a locally created record)", () => {
  it("names the calendar's timezone, since the stored clock carries no offset", () => {
    const time = toGoogleEventTime("2026-07-19T10:30", undefined, TOKYO);
    assert.deepEqual(time, { dateTime: "2026-07-19T10:30:00", timeZone: TOKYO });
  });

  it("reports an empty calendar timezone rather than sending a zone-less dateTime", () => {
    // Google answers an opaque 400 for a dateTime with neither offset nor
    // timeZone, so the caller must be able to see this and say why.
    const time = toGoogleEventTime("2026-07-19T10:30", undefined, "");
    assert.deepEqual(time, { dateTime: "2026-07-19T10:30:00", timeZone: "" });
  });
});

describe("toGoogleEventTime — values that already are Google's own", () => {
  it("passes a raw offset value through (a `start` mapped onto a string field)", () => {
    const time = toGoogleEventTime("2026-07-19T09:00:00+09:00", undefined, TOKYO);
    assert.deepEqual(time, { dateTime: "2026-07-19T09:00:00+09:00" });
  });

  it("treats a bare date as all-day even with no baseline", () => {
    assert.deepEqual(toGoogleEventTime("2026-07-19", undefined, TOKYO), { date: "2026-07-19" });
  });
});

describe("toGoogleEventTime — refuses to invent a time", () => {
  const rejected: [string, unknown][] = [
    ["free text", "next tuesday"],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a number", 20260719],
    ["null", null],
    ["undefined", undefined],
    ["a date-time missing its clock", "2026-07-19T"],
  ];
  for (const [label, value] of rejected) {
    it(`returns null for ${label}`, () => {
      assert.equal(toGoogleEventTime(value, undefined, TOKYO), null);
    });
  }
});

describe("round trip", () => {
  // The property that matters: pulling a value and pushing it back unedited must
  // reproduce what Google had. A regression here silently rewrites every event
  // the user never touched.
  const sentValue = (time: ReturnType<typeof toGoogleEventTime>): string | null => {
    if (time === null) return null;
    return "date" in time ? time.date : time.dateTime;
  };

  const originals = ["2026-07-19T09:00:00+09:00", "2026-07-19T00:00:00Z", "2026-07-19"];
  for (const original of originals) {
    it(`${original} survives pull → push byte-identical`, () => {
      const stored = toCollectionDateTime(original);
      assert.equal(sentValue(toGoogleEventTime(stored, original, TOKYO)), original);
    });
  }

  it("normalises fractional seconds away but keeps the same instant", () => {
    const original = "2026-07-19T09:00:00.500+09:00";
    const stored = toCollectionDateTime(original);
    assert.equal(sentValue(toGoogleEventTime(stored, original, TOKYO)), "2026-07-19T09:00:00+09:00");
  });
});
