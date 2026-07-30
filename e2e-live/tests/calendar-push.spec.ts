import { expect, test } from "@playwright/test";

import {
  createCalendarEvent,
  getCalendar,
  getCalendarEvent,
  getGoogleAccessToken,
  listCalendars,
  pushCalendarForCollection,
  toGoogleEventTime,
  updateCalendarEvent,
  HTTP_CONFLICT,
  HTTP_FORBIDDEN,
  HTTP_PRECONDITION_FAILED,
  type CalendarEventTime,
  type FetchedCalendarEvent,
} from "@mulmoclaude/core/google";

import {
  calendarIdFrom,
  createCalendarCollectionWorkspace,
  deleteEventQuietly,
  liveCalendarBlocker,
  missingCalendarReason,
  newEventId,
  statusOfRejection,
  CALENDAR_FIELDS,
  READONLY_CALENDAR_ENV,
  UNLISTED_CALENDAR_ENV,
  WRITABLE_CALENDAR_ENV,
} from "../fixtures/live-google.ts";

// Live verification of the Collection → Google Calendar push (#2602).
//
// #2598 / #2600 shipped the push with every test fake or mocked: the API shapes
// were read off the Calendar v3 contract, never off an observed 200. Each test
// here pins ONE of the claims that shipped unverified:
//
//   L-GCAL-01  a client-set event id + an offset-less dateTime           (items 1, 2)
//   L-GCAL-02  a duplicate client-set id answers 409, not 400            (item 1)
//   L-GCAL-03  a stale etag answers 412, not 409/400                     (item 3)
//   L-GCAL-04  an all-day event survives a date move as all-day          (item 4)
//   L-GCAL-05  an unlisted calendar reports a timeZone and accepts writes (item 5)
//   L-GCAL-06  a calendar the account only reads answers 403             (item 6)
//   L-GCAL-07  the real push creates, then stays quiet, then updates     (items 1, 2)
//   L-GCAL-08  a read-only calendar is refused as a permissions problem  (item 6)
//
// L-GCAL-01..06 drive `calendar.ts` directly, because #2602 asks about STATUS
// CODES and the push folds those into an outcome. L-GCAL-07 / 08 drive
// `pushCalendarForCollection` — the same function the HTTP route calls — so the
// feature itself is exercised, baseline persistence included.
//
// Nothing here runs without a linked Google account and a throwaway calendar id
// in the env; see `../fixtures/live-google.ts` for the variables.

// A collection stores the clock with no zone (`toCollectionDateTime` drops it),
// so these are the values a locally-created record actually holds.
const LOCAL_START = "2027-03-11T09:30";
const LOCAL_END = "2027-03-11T10:15";
// What Google must echo back: the same wall clock, read in the calendar's zone.
const SENT_START = "2027-03-11T09:30:00";
const SENT_END = "2027-03-11T10:15:00";

const ALL_DAY_START = "2027-03-15";
// Google's all-day `end` is EXCLUSIVE — one day on the 15th ends on the 16th.
const ALL_DAY_END = "2027-03-16";
const MOVED_START = "2027-03-18";
const MOVED_END = "2027-03-19";

const SUMMARY = "e2e-live push probe";
const EDITED_SUMMARY = "e2e-live push probe (edited)";

/** Narrow `toGoogleEventTime`'s nullable result at the call site — a null here
 *  means the push would have refused the record, which is a test-setup bug. */
function pushTime(local: string, previous: string | undefined, timeZone: string): CalendarEventTime {
  const time = toGoogleEventTime(local, previous, timeZone);
  if (time === null) throw new Error(`the push cannot build a Google time from ${JSON.stringify(local)}`);
  return time;
}

/** The event Google currently holds, or a failure naming what was missing. */
async function readEvent(accessToken: string, calendarId: string, eventId: string): Promise<FetchedCalendarEvent> {
  const fetched = await getCalendarEvent(accessToken, { calendarId, eventId });
  if (fetched === null) throw new Error(`Google has no event ${eventId} on ${calendarId}`);
  return fetched;
}

/** Google answers RFC3339 with the calendar's own offset, so the civil part is
 *  what says whether a zone-less dateTime was read in the intended zone. */
const civilPartOf = (rfc3339: string, expected: string): string => rfc3339.slice(0, expected.length);

test.describe("Google Calendar contract behind the push (#2602)", () => {
  test.beforeEach(async () => {
    const blocker = await liveCalendarBlocker();
    test.skip(blocker !== null, blocker ?? "");
  });

  test("L-GCAL-01: client 指定の event id と offset 無し dateTime を Google が受ける (#2602 項目1,2)", async () => {
    const accessToken = await getGoogleAccessToken();
    const calendarId = calendarIdFrom(WRITABLE_CALENDAR_ENV);
    const { timeZone } = await getCalendar(accessToken, calendarId);
    expect(timeZone, "the calendar reports no timeZone, so a zone-less dateTime could never be pushed to it").not.toBe("");

    // Pinned, not merely passed through: if the push ever starts sending an
    // offset instead, this test must fail rather than quietly verify a
    // different shape than the one #2602 asks about.
    const start = pushTime(LOCAL_START, undefined, timeZone);
    const end = pushTime(LOCAL_END, undefined, timeZone);
    expect(start).toEqual({ dateTime: SENT_START, timeZone });

    const eventId = newEventId();
    try {
      const created = await createCalendarEvent(accessToken, { eventId, calendarId, summary: SUMMARY, start, end });
      expect(created.id).toBe(eventId);

      const { event } = await readEvent(accessToken, calendarId, eventId);
      expect(civilPartOf(event.start, SENT_START)).toBe(SENT_START);
      expect(civilPartOf(event.end, SENT_END)).toBe(SENT_END);
    } finally {
      await deleteEventQuietly(accessToken, calendarId, eventId);
    }
  });

  test("L-GCAL-02: 同じ client 指定 id での再 insert は 409 で返る (#2602 項目1)", async () => {
    const accessToken = await getGoogleAccessToken();
    const calendarId = calendarIdFrom(WRITABLE_CALENDAR_ENV);
    const { timeZone } = await getCalendar(accessToken, calendarId);
    const span = { start: pushTime(LOCAL_START, undefined, timeZone), end: pushTime(LOCAL_END, undefined, timeZone) };

    const eventId = newEventId();
    try {
      await createCalendarEvent(accessToken, { eventId, calendarId, summary: SUMMARY, ...span });
      // `createOrAdopt` recovers on 409 and on nothing else, so a 400 here would
      // turn every duplicate into a hard per-record error.
      const status = await statusOfRejection(() => createCalendarEvent(accessToken, { eventId, calendarId, summary: SUMMARY, ...span }));
      expect(status).toBe(HTTP_CONFLICT);
    } finally {
      await deleteEventQuietly(accessToken, calendarId, eventId);
    }
  });

  test("L-GCAL-03: 古い etag での If-Match 書き込みは 412 で返る (#2602 項目3)", async () => {
    const accessToken = await getGoogleAccessToken();
    const calendarId = calendarIdFrom(WRITABLE_CALENDAR_ENV);
    const { timeZone } = await getCalendar(accessToken, calendarId);
    const span = { start: pushTime(LOCAL_START, undefined, timeZone), end: pushTime(LOCAL_END, undefined, timeZone) };

    const eventId = newEventId();
    try {
      await createCalendarEvent(accessToken, { eventId, calendarId, summary: SUMMARY, ...span });
      const { etag } = await readEvent(accessToken, calendarId, eventId);
      expect(etag, "Google returned no etag, so the push's conditional write has nothing to send").not.toBe("");

      // Stands in for the change that lands between the push's read and its
      // write — the window `If-Match` exists to close.
      await updateCalendarEvent(accessToken, { eventId, calendarId, summary: "changed by someone else" });

      const status = await statusOfRejection(() => updateCalendarEvent(accessToken, { eventId, calendarId, summary: EDITED_SUMMARY, ifMatch: etag }));
      expect(status).toBe(HTTP_PRECONDITION_FAILED);
    } finally {
      await deleteEventQuietly(accessToken, calendarId, eventId);
    }
  });

  test("L-GCAL-04: 終日イベントは日付を動かしても終日のまま、exclusive end もずれない (#2602 項目4)", async () => {
    const accessToken = await getGoogleAccessToken();
    const calendarId = calendarIdFrom(WRITABLE_CALENDAR_ENV);
    const { timeZone } = await getCalendar(accessToken, calendarId);

    const eventId = newEventId();
    try {
      await createCalendarEvent(accessToken, {
        eventId,
        calendarId,
        summary: SUMMARY,
        start: { date: ALL_DAY_START },
        end: { date: ALL_DAY_END },
      });
      const created = await readEvent(accessToken, calendarId, eventId);
      expect(created.event.start).toBe(ALL_DAY_START);
      expect(created.event.end).toBe(ALL_DAY_END);

      // What the push does when the user moves the day in the collection: the
      // stored value is the flattened midnight, the baseline is Google's own
      // `date`, and the conversion has to keep the event all-day.
      const movedStart = pushTime(`${MOVED_START}T00:00`, ALL_DAY_START, timeZone);
      const movedEnd = pushTime(`${MOVED_END}T00:00`, ALL_DAY_END, timeZone);
      expect(movedStart).toEqual({ date: MOVED_START });

      await updateCalendarEvent(accessToken, { eventId, calendarId, start: movedStart, end: movedEnd });
      const moved = await readEvent(accessToken, calendarId, eventId);
      expect(moved.event.start).toBe(MOVED_START);
      expect(moved.event.end).toBe(MOVED_END);
      // A timed event would come back as `…T00:00:00+09:00`.
      expect(moved.event.start).not.toContain("T");
    } finally {
      await deleteEventQuietly(accessToken, calendarId, eventId);
    }
  });

  test("L-GCAL-05: calendarList に無いカレンダーでも timeZone が取れて書き込める (#2602 項目5)", async () => {
    const unlisted = calendarIdFrom(UNLISTED_CALENDAR_ENV);
    test.skip(
      unlisted === "",
      missingCalendarReason(UNLISTED_CALENDAR_ENV, "a calendar shared with write access that is NOT added to this account's calendar list"),
    );

    const accessToken = await getGoogleAccessToken();
    const listed = await listCalendars(accessToken);
    expect(
      listed.map((calendar) => calendar.id),
      `${UNLISTED_CALENDAR_ENV} is in this account's calendar list, so it cannot exercise the unlisted path — remove it from the list or point the variable elsewhere`,
    ).not.toContain(unlisted);

    // #2600 iter-4 stopped treating "absent from calendarList" as read-only, on
    // the assumption that the calendar resource still answers with a timezone.
    const direct = await getCalendar(accessToken, unlisted);
    expect(direct.timeZone).not.toBe("");

    const eventId = newEventId();
    try {
      const span = { start: pushTime(LOCAL_START, undefined, direct.timeZone), end: pushTime(LOCAL_END, undefined, direct.timeZone) };
      const created = await createCalendarEvent(accessToken, { eventId, calendarId: unlisted, summary: SUMMARY, ...span });
      expect(created.id).toBe(eventId);
    } finally {
      await deleteEventQuietly(accessToken, unlisted, eventId);
    }
  });

  test("L-GCAL-06: 読み取りしかできないカレンダーへの書き込みは 403 で返る (#2602 項目6)", async () => {
    const readOnly = calendarIdFrom(READONLY_CALENDAR_ENV);
    test.skip(
      readOnly === "",
      missingCalendarReason(READONLY_CALENDAR_ENV, "a calendar this account can read but not write (a subscribed holiday calendar will do)"),
    );

    const accessToken = await getGoogleAccessToken();
    // An offset-bearing span, so a rejection can only be about permissions.
    const status = await statusOfRejection(() =>
      createCalendarEvent(accessToken, {
        calendarId: readOnly,
        summary: SUMMARY,
        startDateTime: `${SENT_START}Z`,
        endDateTime: `${SENT_END}Z`,
      }),
    );
    expect(status).toBe(HTTP_FORBIDDEN);
  });
});

test.describe("Collection → Google push, end to end (#2602)", () => {
  test.beforeEach(async () => {
    const blocker = await liveCalendarBlocker();
    test.skip(blocker !== null, blocker ?? "");
  });

  test("L-GCAL-07: ローカル生成レコードが作成され、2回目は無音、編集後は更新される (#2602 項目1,2)", async () => {
    const accessToken = await getGoogleAccessToken();
    const calendarId = calendarIdFrom(WRITABLE_CALENDAR_ENV);
    const eventId = newEventId();
    const workspace = await createCalendarCollectionWorkspace(calendarId);
    const quiet = { slug: workspace.slug, created: 0, updated: 0, conflicts: 0, localDeletes: 0, skipped: [], errors: [] };

    try {
      await workspace.putRecord(eventId, {
        [CALENDAR_FIELDS.id]: eventId,
        [CALENDAR_FIELDS.summary]: SUMMARY,
        [CALENDAR_FIELDS.start]: LOCAL_START,
        [CALENDAR_FIELDS.end]: LOCAL_END,
      });

      // Compared whole rather than field by field: a `skipped` message is how
      // this feature reports a record it could not push, and asserting only
      // `created` would let that pass silently.
      expect(await pushCalendarForCollection(workspace.slug, workspace.root)).toEqual({ kind: "pushed", result: { ...quiet, created: 1 } });

      const { event } = await readEvent(accessToken, calendarId, eventId);
      expect(event.summary).toBe(SUMMARY);
      expect(civilPartOf(event.start, SENT_START)).toBe(SENT_START);

      // The baseline the first push wrote must make the record look unchanged;
      // without it every click would re-send it and hit the duplicate-id 409.
      expect(await pushCalendarForCollection(workspace.slug, workspace.root)).toEqual({ kind: "pushed", result: quiet });

      await workspace.putRecord(eventId, {
        [CALENDAR_FIELDS.id]: eventId,
        [CALENDAR_FIELDS.summary]: EDITED_SUMMARY,
        [CALENDAR_FIELDS.start]: LOCAL_START,
        [CALENDAR_FIELDS.end]: LOCAL_END,
      });
      expect(await pushCalendarForCollection(workspace.slug, workspace.root)).toEqual({ kind: "pushed", result: { ...quiet, updated: 1 } });

      const after = await readEvent(accessToken, calendarId, eventId);
      expect(after.event.summary).toBe(EDITED_SUMMARY);
    } finally {
      await deleteEventQuietly(accessToken, calendarId, eventId);
      await workspace.cleanup();
    }
  });

  test("L-GCAL-08: 読み取り専用カレンダーへの push は権限の問題として返る (#2602 項目6)", async () => {
    const readOnly = calendarIdFrom(READONLY_CALENDAR_ENV);
    test.skip(
      readOnly === "",
      missingCalendarReason(READONLY_CALENDAR_ENV, "a calendar this account can read but not write (a subscribed holiday calendar will do)"),
    );

    const eventId = newEventId();
    const workspace = await createCalendarCollectionWorkspace(readOnly);
    try {
      await workspace.putRecord(eventId, {
        [CALENDAR_FIELDS.id]: eventId,
        [CALENDAR_FIELDS.summary]: SUMMARY,
        [CALENDAR_FIELDS.start]: LOCAL_START,
        [CALENDAR_FIELDS.end]: LOCAL_END,
      });

      // The up-front role gate, not the per-event 403: a subscribed read-only
      // calendar IS in the calendar list, so the push learns the real reason
      // before it writes anything. The 403 branch in `writeFailure` is only
      // reachable for a calendar that is unlisted AND unwritable, which needs a
      // second account to set up — L-GCAL-06 pins Google's status for it.
      const outcome = await pushCalendarForCollection(workspace.slug, workspace.root);
      if (outcome.kind !== "read-only") throw new Error(`expected a read-only outcome, got ${JSON.stringify(outcome)}`);
      expect(["reader", "freeBusyReader"]).toContain(outcome.accessRole);
    } finally {
      await workspace.cleanup();
    }
  });
});
