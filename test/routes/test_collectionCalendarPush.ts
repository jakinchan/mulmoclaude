// Unit tests for the push route's response shaping (#2598).
//
// The rule under test: no setup failure may leave the UI reading "0 created".
// An unlinked account and a read-only calendar both produce zero writes, and a
// body that reports only the counts would present either as "nothing to push" —
// sending the user looking at their data instead of at their settings.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calendarPushBody, pushReadOnlyError, PUSH_NOT_DECLARED_ERROR, PUSH_NOT_LINKED_ERROR } from "../../server/api/routes/collectionCalendarPush.js";
import { isDeniedAccessRole, type CalendarCollectionPushResult } from "@mulmoclaude/core/google";

const result = (overrides: Partial<CalendarCollectionPushResult> = {}): CalendarCollectionPushResult => ({
  slug: "my-schedule",
  created: 0,
  updated: 0,
  conflicts: 0,
  localDeletes: 0,
  skipped: [],
  errors: [],
  ...overrides,
});

describe("calendarPushBody — states that must not read as success", () => {
  it("reports an unlinked Google account as an error, not an empty push", () => {
    const body = calendarPushBody({ kind: "not-linked" });
    assert.deepEqual(body.errors, [PUSH_NOT_LINKED_ERROR]);
    assert.equal(body.created, 0);
  });

  it("reports a collection that declares no calendar", () => {
    assert.deepEqual(calendarPushBody({ kind: "not-a-calendar" }).errors, [PUSH_NOT_DECLARED_ERROR]);
  });

  it("names the access role when the calendar cannot be written to", () => {
    const body = calendarPushBody({ kind: "read-only", accessRole: "reader" });
    assert.deepEqual(body.errors, [pushReadOnlyError("reader")]);
    assert.match(body.errors[0] ?? "", /owner or writer/);
  });

  it("still explains itself when Google reported no role at all", () => {
    assert.match(pushReadOnlyError(""), /read access/);
  });

  // A setup-phase throw (revoked grant, Calendar API unreachable) used to reach
  // the route as a generic 500 while its siblings answered in this shape.
  // (CodeRabbit review.)
  it("passes a setup failure through as an error in the same shape", () => {
    const body = calendarPushBody({ kind: "failed", message: "Google Calendar API: HTTP 503" });
    assert.deepEqual(body.errors, ["Google Calendar API: HTTP 503"]);
    assert.equal(body.pushed, true);
    assert.equal(body.created, 0);
  });

  it("marks every outcome as `pushed` so the client has one success shape", () => {
    const outcomes = [
      { kind: "not-linked" },
      { kind: "not-a-calendar" },
      { kind: "read-only", accessRole: "reader" },
      { kind: "failed", message: "boom" },
    ] as const;
    for (const outcome of outcomes) {
      assert.equal(calendarPushBody(outcome).pushed, true);
    }
  });
});

describe("isDeniedAccessRole — the up-front writability gate", () => {
  // Refusing before any API call is only allowed on POSITIVE evidence. A
  // calendar absent from `calendarList` reports no role, and hard-denying that
  // would block the feature outright for a calendar shared with write access
  // that the user simply has not added to their list. (Codex review on #2600.)
  it("does not deny a calendar whose role is unknown", () => {
    assert.equal(isDeniedAccessRole(null), false);
  });

  it("allows owner and writer", () => {
    assert.equal(isDeniedAccessRole("owner"), false);
    assert.equal(isDeniedAccessRole("writer"), false);
  });

  it("denies the read-only roles Google reports", () => {
    assert.equal(isDeniedAccessRole("reader"), true);
    assert.equal(isDeniedAccessRole("freeBusyReader"), true);
  });

  // A listed calendar reporting an empty role is evidence of a role we do not
  // recognise, not of an unlisted calendar — those carry null.
  it("denies an unrecognised role rather than assuming it can write", () => {
    assert.equal(isDeniedAccessRole(""), true);
    assert.equal(isDeniedAccessRole("somethingNew"), true);
  });
});

describe("calendarPushBody — a real push", () => {
  it("passes the counts through", () => {
    const body = calendarPushBody({ kind: "pushed", result: result({ created: 2, updated: 3, conflicts: 1, localDeletes: 4 }) });
    assert.deepEqual(body, { pushed: true, created: 2, updated: 3, conflicts: 1, localDeletes: 4, skipped: [], errors: [] });
  });

  it("keeps skipped reasons separate from errors — they need different wording", () => {
    const body = calendarPushBody({
      kind: "pushed",
      result: result({ skipped: ["abcde: needs a mapped start and end"], errors: ["ev9: HTTP 500"] }),
    });
    assert.deepEqual(body.skipped, ["abcde: needs a mapped start and end"]);
    assert.deepEqual(body.errors, ["ev9: HTTP 500"]);
  });

  it("reports a conflict count without touching either side", () => {
    const body = calendarPushBody({ kind: "pushed", result: result({ conflicts: 2 }) });
    assert.equal(body.conflicts, 2);
    assert.deepEqual(body.errors, []);
  });
});
