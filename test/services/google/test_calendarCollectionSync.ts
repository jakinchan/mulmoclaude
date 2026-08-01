// Unit tests for the LLM-free Google Calendar → collection projection
// (#2095). The mapping is the part that silently corrupts data if it drifts:
// the primary field must always carry the Google event id (that is what makes
// a re-sync update instead of duplicate), and only declared fields may be
// written.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allUnpushed,
  anySyncedCollectionSurvives,
  applyPlanFor,
  baselineRecord,
  classifyDelete,
  classifyWrite,
  locallyChangedFields,
  pushableMap,
  toShadowEvent,
  groupByCalendar,
  unsentEditGuard,
  heldBack,
  isUnpushed,
  mergeIntoExisting,
  orphanedCalendarId,
  pullableEvents,
  pullProtectionFor,
  pushAndProtect,
  shadowUpdates,
  toCollectionRecord,
  syncCalendarForCollection,
  unpushedFor,
  unsyncedGroups,
  withKeyedLock,
} from "@mulmoclaude/core/google";
import type {
  CalendarCollectionPushResult,
  CalendarCollectionSyncResult,
  CalendarDeclaring,
  CalendarEventSummary,
  ManualCalendarSyncDeps,
  PullProtectionDeps,
} from "@mulmoclaude/core/google";
import { parseIsoDateTime } from "@mulmoclaude/core/collection";
import type { CollectionFieldSpec, CollectionItem } from "@mulmoclaude/core/collection";
import type { LoadedCollection } from "@mulmoclaude/core/collection/server";

const event = (overrides: Partial<CalendarEventSummary> = {}): CalendarEventSummary => ({
  id: "ev-1",
  summary: "Standup",
  start: "2026-07-19T09:00:00+09:00",
  end: "2026-07-19T09:15:00+09:00",
  htmlLink: "https://calendar.google.com/event?eid=ev-1",
  status: "confirmed",
  colorId: "7",
  description: "",
  location: "",
  ...overrides,
});

// The recipe shape from `assets/helps/google-calendar-collection.md`: the
// start/end columns are `datetime`, everything else is text.
const recipeFields: Record<string, CollectionFieldSpec> = {
  gid: { type: "string", label: "ID", primary: true },
  title: { type: "string", label: "Event" },
  on: { type: "datetime", label: "Start" },
  until: { type: "datetime", label: "End" },
  colour: { type: "string", label: "Colour" },
};

describe("toCollectionRecord (#2095)", () => {
  it("projects mapped event fields onto the collection's own field names", () => {
    const record = toCollectionRecord(event(), { title: "summary", on: "start", until: "end" }, "gid", recipeFields);
    assert.equal(record.title, "Standup");
    assert.equal(record.on, "2026-07-19T09:00:00");
    assert.equal(record.until, "2026-07-19T09:15:00");
  });

  it("always writes the Google event id into the primary field", () => {
    const record = toCollectionRecord(event({ id: "abc123" }), { title: "summary" }, "gid", recipeFields);
    assert.equal(record.gid, "abc123");
  });

  it("writes ONLY the mapped fields plus the primary — no stray event fields leak in", () => {
    const record = toCollectionRecord(event(), { title: "summary" }, "gid", recipeFields);
    assert.deepEqual(Object.keys(record).sort(), ["gid", "title"]);
  });

  it("supports an empty map (records then carry just the id)", () => {
    const record = toCollectionRecord(event(), {}, "gid", recipeFields);
    assert.deepEqual(record, { gid: "ev-1" });
  });

  it("keeps an empty optional value as an empty string rather than dropping the key", () => {
    const record = toCollectionRecord(event({ colorId: "" }), { colour: "colorId" }, "gid", recipeFields);
    assert.equal(record.colour, "");
    assert.ok("colour" in record);
  });

  it("lets the primary field win even if the map tries to target it", () => {
    // Schema validation rejects this, but the projection must not corrupt the
    // id if a hand-edited schema slips through.
    const record = toCollectionRecord(event({ id: "real-id" }), { gid: "summary" }, "gid", recipeFields);
    assert.equal(record.gid, "real-id");
  });
});

// Google's own shapes are rejected by the `datetime` record lint, so every
// synced record was reported as a data problem until the projection normalised
// them (#2310). Normalisation keys off the TARGET field's declared type, never
// the source field name.
describe("toCollectionRecord datetime normalisation (#2310)", () => {
  it("stores a timed event in the shape the collection parses", () => {
    const record = toCollectionRecord(event(), { on: "start", until: "end" }, "gid", recipeFields);
    assert.notEqual(parseIsoDateTime(record.on), null, "a synced start must satisfy the datetime lint");
    assert.notEqual(parseIsoDateTime(record.until), null, "a synced end must satisfy the datetime lint");
  });

  it("anchors an all-day event at midnight so it parses as a datetime", () => {
    const allDay = event({ start: "2026-07-19", end: "2026-07-20" });
    const record = toCollectionRecord(allDay, { on: "start", until: "end" }, "gid", recipeFields);
    assert.equal(record.on, "2026-07-19T00:00");
    assert.equal(record.until, "2026-07-20T00:00");
    assert.notEqual(parseIsoDateTime(record.on), null);
  });

  it("leaves a `string` target byte-for-byte alone — the user asked for Google's raw value", () => {
    const stringFields: Record<string, CollectionFieldSpec> = { on: { type: "string", label: "Start" } };
    const record = toCollectionRecord(event(), { on: "start" }, "gid", stringFields);
    assert.equal(record.on, "2026-07-19T09:00:00+09:00");
  });

  it("leaves a field the schema does not declare alone", () => {
    const record = toCollectionRecord(event(), { stray: "start" }, "gid", recipeFields);
    assert.equal(record.stray, "2026-07-19T09:00:00+09:00");
  });

  it("ignores a spec reachable only through the prototype chain", () => {
    // The declared shape is what the record lint reads, and it reads own
    // properties. Typing a field off an inherited spec would normalise a value
    // the collection never declared as a datetime.
    const inheritedFields: Record<string, CollectionFieldSpec> = Object.create({ on: { type: "datetime", label: "Start" } });
    const record = toCollectionRecord(event(), { on: "start" }, "gid", inheritedFields);
    assert.equal(record.on, "2026-07-19T09:00:00+09:00");
  });

  it("keeps an empty datetime value empty instead of inventing a time", () => {
    const record = toCollectionRecord(event({ start: "" }), { on: "start" }, "gid", recipeFields);
    assert.equal(record.on, "");
  });
});

// A record file is written whole, so the pull used to rewrite it from the map
// alone — silently deleting any column the map does not name. That made a
// local note next to a mirrored event impossible to keep (#2620).
describe("mergeIntoExisting (#2620 local columns survive a pull)", () => {
  const projected = toCollectionRecord(event(), { title: "summary", on: "start" }, "gid", recipeFields);

  it("keeps a column the map does not name", () => {
    const merged = mergeIntoExisting({ gid: "ev-1", title: "old", notes: "call Alice first" }, projected);
    assert.equal(merged.notes, "call Alice first");
  });

  it("still lets Google win on the fields it owns", () => {
    const merged = mergeIntoExisting({ gid: "ev-1", title: "old", on: "1999-01-01T00:00" }, projected);
    assert.equal(merged.title, "Standup");
    assert.equal(merged.on, "2026-07-19T09:00:00");
  });

  it("writes the projection as-is when the record is new", () => {
    assert.deepEqual(mergeIntoExisting(null, projected), projected);
  });

  it("never lets a stale local value shadow the event id", () => {
    const merged = mergeIntoExisting({ gid: "someone-elses-id" }, projected);
    assert.equal(merged.gid, "ev-1");
  });
});

// The push → pull cycle's other half. When the push refuses a record (edited on
// both sides), holding its BASELINE back is what keeps the conflict detectable:
// advance it to Google's new value and the next push sees a plain one-sided
// local edit and silently overwrites Google (#2620).
describe("pullableEvents (#2620 a refused push protects its record)", () => {
  const window = [event({ id: "a" }), event({ id: "b" }), event({ id: "c" })];

  it("passes the whole window through when the push sent everything", () => {
    assert.deepEqual(
      pullableEvents(window, new Set()).map((entry) => entry.id),
      ["a", "b", "c"],
    );
  });

  it("drops the events whose records the push could not send", () => {
    assert.deepEqual(
      pullableEvents(window, new Set(["b"])).map((entry) => entry.id),
      ["a", "c"],
    );
  });

  it("ignores an unpushed id that is not in this window", () => {
    assert.equal(pullableEvents(window, new Set(["zz"])).length, 3);
  });
});

// The push classifies each record; only two of those states mean "the local edit
// exists nowhere but here". `skipped` is deliberately NOT one of them — its
// documented recovery for an id already taken in Google is to let the pull
// write, so protecting it would stall that collection forever (#2620).
describe("isUnpushed (#2620 which outcomes the pull must not overwrite)", () => {
  it("protects a both-sides conflict", () => {
    assert.equal(isUnpushed("conflict"), true);
  });

  it("protects an unexpected failure", () => {
    assert.equal(isUnpushed("error"), true);
  });

  it("does NOT protect a skipped record — several of its reasons are recovered by pulling", () => {
    assert.equal(isUnpushed("skipped"), false);
  });

  it("does not protect a record that pushed cleanly", () => {
    assert.equal(isUnpushed("created"), false);
    assert.equal(isUnpushed("updated"), false);
    assert.equal(isUnpushed("unchanged"), false);
  });
});

// A calendar can back several collections, and one collection's unsent edit says
// nothing about the others. Sharing one protected set across the group starved a
// collection that never even declares `autoPush` — a neighbour's conflict froze
// its records, and the token still advanced so Google never resent them (Codex
// review on #2666).
describe("unpushedFor / allUnpushed (#2620 protection is scoped per collection)", () => {
  const unpushed = new Map<string, ReadonlySet<string>>([
    ["mine", new Set(["a"])],
    ["theirs", new Set(["b"])],
  ]);

  it("gives a collection only what ITS OWN push failed to send", () => {
    assert.deepEqual([...(unpushedFor(unpushed, "mine") ?? [])], ["a"]);
  });

  // Since #2683 every collection in the group gets an entry, so an absent slug
  // means "not on this calendar" rather than "did not push".
  it("protects nothing for a slug that is not in this group", () => {
    assert.equal(unpushedFor(unpushed, "other-calendar")?.size, 0);
  });

  it("does not let one collection's conflict freeze another's records", () => {
    assert.equal(unpushedFor(unpushed, "mine")?.has("b"), false);
  });

  // The other half of the asymmetry: `.push-state.json` holds ONE baseline per
  // calendar, so the holdback there must cover every collection on it.
  it("holds the shared baseline back for every collection's conflicts", () => {
    assert.deepEqual([...allUnpushed(unpushed)].sort(), ["a", "b"]);
  });

  it("holds nothing back when every push landed", () => {
    assert.equal(allUnpushed(new Map()).size, 0);
  });

  // Fail closed. A read that failed says nothing about whether the pull's writes
  // would, so pulling with no protection would destroy exactly the edits this
  // exists to protect (CodeRabbit review on #2666).
  it("answers null when a collection's protection could not be worked out", () => {
    assert.equal(unpushedFor(new Map([["broken", null]]), "broken"), null);
  });

  it("distinguishes unknown protection from a collection that simply pushed cleanly", () => {
    const mixed = new Map<string, ReadonlySet<string> | null>([
      ["broken", null],
      ["fine", new Set()],
    ]);
    assert.equal(unpushedFor(mixed, "broken"), null);
    assert.equal(unpushedFor(mixed, "fine")?.size, 0);
  });

  it("leaves an unknown entry out of the baseline union — it reports an error instead", () => {
    const mixed = new Map<string, ReadonlySet<string> | null>([
      ["broken", null],
      ["fine", new Set(["a"])],
    ]);
    assert.deepEqual([...allUnpushed(mixed)], ["a"]);
  });
});

describe("shadowUpdates (#2620 a refused push holds its baseline back)", () => {
  it("records what Google now says for every event by default", () => {
    const updates = shadowUpdates([event({ id: "a" }), event({ id: "b" })]);
    assert.deepEqual(Object.keys(updates).sort(), ["a", "b"]);
  });

  it("leaves out an event whose record the push could not send", () => {
    const updates = shadowUpdates([event({ id: "a" }), event({ id: "b" })], new Set(["b"]));
    assert.deepEqual(Object.keys(updates), ["a"]);
    assert.equal(Object.hasOwn(updates, "b"), false, "a held-back baseline must be absent, not null — null DELETES it");
  });

  it("still clears the baseline of a cancelled event", () => {
    assert.equal(shadowUpdates([event({ id: "a", status: "cancelled" })]).a, null);
  });

  it("does not clear the baseline of a cancelled event the push could not send", () => {
    assert.deepEqual(shadowUpdates([event({ id: "a", status: "cancelled" })], new Set(["a"])), {});
  });
});

// The sync token is keyed by calendarId, so syncing collection-by-collection
// let the first collection advance the shared token and left every later
// collection on that calendar reading an already-consumed window — silently
// missing those events forever. Grouping is what makes the fan-out correct
// (Codex + CodeRabbit review on #2184).
const collectionOn = (slug: string, calendarId?: string): LoadedCollection =>
  ({ slug, schema: { googleCalendar: { calendarId, map: {} } } }) as unknown as LoadedCollection;

describe("groupByCalendar (#2184 shared-token fan-out)", () => {
  it("puts every collection reading the same calendar in one group", () => {
    const groups = groupByCalendar([collectionOn("a", "work"), collectionOn("b", "work")]);
    assert.equal(groups.size, 1);
    assert.deepEqual(
      groups.get("work")?.map((entry) => entry.slug),
      ["a", "b"],
    );
  });

  it("keeps distinct calendars in separate groups", () => {
    const groups = groupByCalendar([collectionOn("a", "work"), collectionOn("b", "home")]);
    assert.equal(groups.size, 2);
    assert.deepEqual(
      groups.get("work")?.map((entry) => entry.slug),
      ["a"],
    );
    assert.deepEqual(
      groups.get("home")?.map((entry) => entry.slug),
      ["b"],
    );
  });

  it("groups collections that omit calendarId together (all mean the primary)", () => {
    const groups = groupByCalendar([collectionOn("a"), collectionOn("b")]);
    assert.equal(groups.size, 1);
    assert.equal(groups.get("primary")?.length, 2);
  });

  // An omitted id and an explicit "primary" address the same calendar and
  // therefore share ONE sync token. Grouping them apart let one group advance
  // the token out from under the other — the exact loss grouping exists to
  // prevent (Codex review on #2184).
  it('puts an omitted calendarId and an explicit "primary" in the SAME group', () => {
    const groups = groupByCalendar([collectionOn("omitted"), collectionOn("explicit", "primary")]);
    assert.equal(groups.size, 1, "mixed declarations must not split into two groups sharing one token");
    assert.deepEqual(
      groups.get("primary")?.map((entry) => entry.slug),
      ["omitted", "explicit"],
    );
  });

  it("treats an empty-string calendarId as the primary too", () => {
    const groups = groupByCalendar([collectionOn("blank", ""), collectionOn("omitted")]);
    assert.equal(groups.size, 1);
    assert.equal(groups.get("primary")?.length, 2);
  });

  it("returns no groups for no declaring collections", () => {
    assert.equal(groupByCalendar([]).size, 0);
  });
});

// Which failures hold the sync token is the difference between "retry next
// run" and "this calendar never syncs again": a permanently-unwritable id must
// NOT hold the token, or every run re-fetches the same window, fails on the
// same event, and the calendar dies silently.
describe("apply-failure classification (#2184)", () => {
  it("counts a successful write", () => {
    assert.equal(classifyWrite("ev-1", "ok").kind, "written");
  });

  it("treats an unusable event id as unwritable, NOT a retryable error", () => {
    const outcome = classifyWrite("bad@id", "invalid-id");
    assert.equal(outcome.kind, "unwritable", "retrying an invalid id forever would kill the whole calendar's sync");
  });

  it("treats a path escape as a retryable error (it can be fixed)", () => {
    assert.equal(classifyWrite("ev-1", "path-escape").kind, "error");
  });

  it("treats a write conflict as a retryable error", () => {
    assert.equal(classifyWrite("ev-1", "conflict").kind, "error");
  });

  it("counts a successful delete", () => {
    assert.equal(classifyDelete("ev-1", "ok").kind, "removed");
  });

  it("treats deleting a never-stored event as a benign skip", () => {
    assert.equal(classifyDelete("ev-1", "not-found").kind, "skipped");
  });

  it("treats an unusable id on delete as unwritable too", () => {
    assert.equal(classifyDelete("bad@id", "invalid-id").kind, "unwritable");
  });

  it("names the event in every failure message so the log is actionable", () => {
    const outcome = classifyWrite("ev-42", "path-escape");
    assert.ok(outcome.kind === "error" && outcome.message.includes("ev-42"));
  });
});

// #2428. Sync tokens are keyed by calendar, not by collection, so a deleted
// collection's token outlives it — and a collection recreated on the same
// calendar then resumes from it and receives only the delta, never the history.
// This is the rule that decides whether the token may go.
describe("orphanedCalendarId (#2428)", () => {
  // Only the calendar matters here — `CalendarDeclaring` is deliberately the
  // minimum the rule reads, so the field map a real schema carries is absent.
  const reading = (calendarId?: string): CalendarDeclaring => ({ googleCalendar: { calendarId } });

  it("names the calendar when nothing else reads it", () => {
    assert.equal(orphanedCalendarId(reading("work"), []), "work");
  });

  // The expensive mistake in the other direction: clearing a token another
  // collection is still using forces it into a full re-walk on the next sync.
  it("holds the token while another collection still reads the calendar", () => {
    assert.equal(orphanedCalendarId(reading("work"), [reading("work")]), null);
  });

  it("clears when the survivors read OTHER calendars", () => {
    assert.equal(orphanedCalendarId(reading("work"), [reading("home"), reading("family")]), "work");
  });

  it("ignores survivors that declare no calendar at all", () => {
    assert.equal(orphanedCalendarId(reading("work"), [{}, {}]), "work");
  });

  it("returns null for a collection that never read a calendar", () => {
    assert.equal(orphanedCalendarId({}, []), null);
  });

  // Same canonicalisation as `groupByCalendar`: an omitted id and an explicit
  // "primary" address ONE calendar and share ONE token, so treating them as
  // different keys here would clear a token that is still in use.
  it("treats an omitted calendarId as the primary calendar", () => {
    assert.equal(orphanedCalendarId(reading(), []), "primary");
  });

  it("does not clear `primary` while a collection with an omitted id survives", () => {
    assert.equal(orphanedCalendarId(reading("primary"), [reading()]), null);
  });

  it("does not clear an omitted id while an explicit `primary` survives", () => {
    assert.equal(orphanedCalendarId(reading(), [reading("primary")]), null);
  });
});

// #2428 follow-up (CodeRabbit on PR #2551). The sync opens with a
// `discoverCollections()` snapshot, so a delete landing mid-run has already
// cleared this calendar's token by the time the token write happens. Saving
// anyway resurrects exactly the orphan the delete removed.
describe("anySyncedCollectionSurvives (#2428 mid-sync delete)", () => {
  const collectionIn = (skillDir: string) => ({ skillDir });
  const existing =
    (...alive: string[]) =>
    (absPath: string) =>
      Promise.resolve(alive.includes(absPath));

  it("lets the token advance while the collection still exists", async () => {
    assert.equal(await anySyncedCollectionSurvives([collectionIn("/ws/.claude/skills/cal")], existing("/ws/.claude/skills/cal")), true);
  });

  it("holds the token back when the only collection was deleted mid-sync", async () => {
    assert.equal(await anySyncedCollectionSurvives([collectionIn("/ws/.claude/skills/cal")], existing()), false);
  });

  // One survivor still needs the incremental position, so the token must
  // advance even though a sibling on the same calendar was deleted.
  it("advances when at least one of several survives", async () => {
    const group = [collectionIn("/ws/.claude/skills/gone"), collectionIn("/ws/.claude/skills/kept")];
    assert.equal(await anySyncedCollectionSurvives(group, existing("/ws/.claude/skills/kept")), true);
  });

  it("holds the token back when every collection in the group is gone", async () => {
    const group = [collectionIn("/ws/.claude/skills/gone-a"), collectionIn("/ws/.claude/skills/gone-b")];
    assert.equal(await anySyncedCollectionSurvives(group, existing()), false);
  });

  // Defensive: `groupByCalendar` never yields an empty group, but "nothing
  // consumed the window" must never advance the token either.
  it("treats an empty group as no survivor", async () => {
    assert.equal(await anySyncedCollectionSurvives([], existing("/ws/.claude/skills/cal")), false);
  });
});

// The trigger behind "the collection shows up already populated" (#2427): a
// calendar with no stored token has never synced, which is exactly the state a
// just-created collection is in. The rule fires on every config write, so what
// keeps it from re-walking calendars forever is that the first sync stores a
// token and the calendar stops matching.
describe("unsyncedGroups (#2427 first sync)", () => {
  const tokens =
    (stored: Record<string, string>) =>
    (calendarId: string): Promise<string | null> =>
      Promise.resolve(stored[calendarId] ?? null);

  const groups = (...calendarIds: string[]) => new Map(calendarIds.map((calendarId) => [calendarId, [`${calendarId}-collection`]]));

  it("keeps a calendar that has never synced", async () => {
    const pending = await unsyncedGroups(groups("work"), tokens({}));
    assert.deepEqual([...pending.keys()], ["work"]);
  });

  it("drops a calendar that already holds a sync token", async () => {
    const pending = await unsyncedGroups(groups("work"), tokens({ work: "tok-1" }));
    assert.equal(pending.size, 0);
  });

  it("keeps only the never-synced calendars in a mixed set", async () => {
    const pending = await unsyncedGroups(groups("work", "home", "family"), tokens({ home: "tok-1" }));
    assert.deepEqual([...pending.keys()].sort(), ["family", "work"]);
  });

  it("carries each kept calendar's collections through untouched", async () => {
    const pending = await unsyncedGroups(groups("work"), tokens({}));
    assert.deepEqual(pending.get("work"), ["work-collection"]);
  });

  it("returns an empty map when nothing declares a calendar", async () => {
    assert.equal((await unsyncedGroups(new Map(), tokens({}))).size, 0);
  });

  // An empty string is a stored token, not a missing one — treating it as
  // missing would re-walk the whole calendar on every config write.
  it("treats an empty-string token as synced", async () => {
    const pending = await unsyncedGroups(groups("work"), tokens({ work: "" }));
    assert.equal(pending.size, 0);
  });
});

/** Runs whose completion the test controls, recording the order they started
 *  in — "did the second one start early?" is the question the lock answers. */
function trackedRuns() {
  const started: string[] = [];
  const releases = new Map<string, (value: string) => void>();
  const run = (label: string) => (): Promise<string> => {
    started.push(label);
    return new Promise<string>((resolve) => releases.set(label, resolve));
  };
  const release = (label: string): void => releases.get(label)?.(label);
  return { run, started, release };
}

/** Let every pending microtask settle before asserting on start order. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Three doors lead into one calendar — the scheduler, the create trigger and
// the Refresh button — and the sync token is keyed by calendar, not by caller.
// Two passes running at once would both load the SAME token and walk the same
// window (idempotent, but a wasted full walk), so they queue instead
// (CodeRabbit review #2566).
describe("withKeyedLock (#2566 per-calendar queuing)", () => {
  it("holds the second run on a key until the first settles", async () => {
    const locks = new Map<string, Promise<unknown>>();
    const { run, started, release } = trackedRuns();
    const first = withKeyedLock(locks, "work", run("a"));
    const second = withKeyedLock(locks, "work", run("b"));
    await settle();
    assert.deepEqual(started, ["a"], "the second pass must not read the token the first is still advancing");

    release("a");
    await first;
    await settle();
    assert.deepEqual(started, ["a", "b"]);
    release("b");
    assert.equal(await second, "b");
  });

  it("runs different calendars concurrently — the token is per calendar", async () => {
    const locks = new Map<string, Promise<unknown>>();
    const { run, started, release } = trackedRuns();
    const work = withKeyedLock(locks, "work", run("a"));
    const home = withKeyedLock(locks, "home", run("b"));
    await settle();
    assert.deepEqual(started.sort(), ["a", "b"]);
    release("a");
    release("b");
    assert.deepEqual(await Promise.all([work, home]), ["a", "b"]);
  });

  it("lets the queue advance after a failed run", async () => {
    const locks = new Map<string, Promise<unknown>>();
    const { run, started, release } = trackedRuns();
    const failing = withKeyedLock(locks, "work", () => Promise.reject(new Error("boom")));
    const next = withKeyedLock(locks, "work", run("b"));
    await assert.rejects(failing, /boom/);
    await settle();
    assert.deepEqual(started, ["b"], "one calendar's failure must not wedge that calendar forever");
    release("b");
    assert.equal(await next, "b");
  });

  it("releases the key once nothing is queued behind it", async () => {
    const locks = new Map<string, Promise<unknown>>();
    await withKeyedLock(locks, "work", () => Promise.resolve(1));
    await settle();
    assert.equal(locks.size, 0, "the map must not grow one entry per calendar forever");
  });

  it("returns each caller its own run's value", async () => {
    const locks = new Map<string, Promise<unknown>>();
    const results = await Promise.all([
      withKeyedLock(locks, "work", () => Promise.resolve("first")),
      withKeyedLock(locks, "work", () => Promise.resolve("second")),
    ]);
    assert.deepEqual(results, ["first", "second"]);
  });
});

// The Refresh button's three answers. Two of them are "could not run", and a
// wrong one sends the user fixing the wrong thing — link an account for a
// collection that never declared a calendar, or hunt for missing events that a
// missing grant explains. Exercised through injected fakes, so no workspace on
// disk and no Google grant (CodeRabbit review #2566).
describe("syncCalendarForCollection (#2427 manual refresh)", () => {
  const syncedResult = (slug: string): CalendarCollectionSyncResult => ({ slug, written: 2, removed: 0, unwritable: [], withheld: [], errors: [] });

  const deps = (overrides: Partial<ManualCalendarSyncDeps> = {}): ManualCalendarSyncDeps & { ranWith: Map<string, LoadedCollection[]>[] } => {
    const ranWith: Map<string, LoadedCollection[]>[] = [];
    return {
      ranWith,
      loadGroups: () => Promise.resolve(groupByCalendar([collectionOn("my-schedule", "work")])),
      isLinked: () => Promise.resolve(true),
      runGroups: (groups) => {
        ranWith.push(groups);
        return Promise.resolve([...groups].flatMap(([, collections]) => collections.map((entry) => syncedResult(entry.slug))));
      },
      ...overrides,
    };
  };

  it("syncs the calendar the collection reads", async () => {
    const fake = deps();
    const outcome = await syncCalendarForCollection("my-schedule", "/ws", fake);
    assert.equal(outcome.kind, "synced");
    assert.deepEqual(outcome.kind === "synced" ? outcome.results.map((entry) => entry.slug) : [], ["my-schedule"]);
  });

  it("reports a collection that declares no calendar rather than syncing nothing", async () => {
    const fake = deps();
    const outcome = await syncCalendarForCollection("plain-collection", "/ws", fake);
    assert.equal(outcome.kind, "not-a-calendar");
    assert.equal(fake.ranWith.length, 0, "nothing may be fetched for a collection that never asked for a sync");
  });

  it("reports an unlinked Google account rather than a successful empty sync", async () => {
    const fake = deps({ isLinked: () => Promise.resolve(false) });
    const outcome = await syncCalendarForCollection("my-schedule", "/ws", fake);
    assert.equal(outcome.kind, "not-linked");
    assert.equal(fake.ranWith.length, 0);
  });

  // Order matters: answering "link your account" for a collection that has no
  // googleCalendar block points the user at the wrong fix.
  it("answers not-a-calendar before not-linked", async () => {
    const outcome = await syncCalendarForCollection("plain-collection", "/ws", deps({ isLinked: () => Promise.resolve(false) }));
    assert.equal(outcome.kind, "not-a-calendar");
  });

  // The whole group syncs (one shared token), but ONLY the group this
  // collection belongs to — a calendar it does not read must not be walked.
  it("runs the owning calendar's group and leaves other calendars alone", async () => {
    const fake = deps({
      loadGroups: () => Promise.resolve(groupByCalendar([collectionOn("my-schedule", "work"), collectionOn("team", "work"), collectionOn("private", "home")])),
    });
    const outcome = await syncCalendarForCollection("my-schedule", "/ws", fake);
    assert.deepEqual([...fake.ranWith[0].keys()], ["work"]);
    assert.deepEqual(outcome.kind === "synced" ? outcome.results.map((entry) => entry.slug).sort() : [], ["my-schedule", "team"]);
  });
});

// A collection that never declares `autoPush` is in the SAME state a failed push
// leaves behind — its local edits are unsent — yet it used to be filtered out of
// the push loop entirely, so it got an empty protected set on every run. The
// pull then overwrote those edits AND advanced the shared baseline past them,
// after which no conflict could be detected any more (#2683). No concurrency and
// no failure needed: one scheduled sync was enough.
describe("pullProtectionFor / pushAndProtect (#2683 a collection that never pushes still needs protecting)", () => {
  const calendarCollection = (slug: string, autoPush: boolean): LoadedCollection =>
    ({ slug, schema: { googleCalendar: { calendarId: "work", map: {}, autoPush } } }) as unknown as LoadedCollection;

  const pushResult = (slug: string, unpushedIds: string[]): CalendarCollectionPushResult => ({
    slug,
    created: 0,
    updated: 0,
    conflicts: unpushedIds.length,
    localDeletes: 0,
    skipped: [],
    errors: [],
    unpushedIds,
  });

  const protectionDeps = (overrides: Partial<PullProtectionDeps> = {}): PullProtectionDeps & { pushedSlugs: string[] } => {
    const pushedSlugs: string[] = [];
    return {
      pushedSlugs,
      pushNow: (collection) => {
        pushedSlugs.push(collection.slug);
        return Promise.resolve({ kind: "pushed", result: pushResult(collection.slug, []) });
      },
      unsentEdits: () => Promise.resolve([]),
      ...overrides,
    };
  };

  it("protects the unsent local edits of a collection that never declares autoPush", async () => {
    const deps = protectionDeps({ unsentEdits: () => Promise.resolve(["ev-1"]) });
    const protection = await pullProtectionFor(calendarCollection("mirror", false), "/ws", deps);
    assert.deepEqual([...(protection ?? [])], ["ev-1"]);
  });

  it("never pushes a collection that did not ask to be pushed", async () => {
    const deps = protectionDeps({ unsentEdits: () => Promise.resolve(["ev-1"]) });
    await pullProtectionFor(calendarCollection("mirror", false), "/ws", deps);
    assert.deepEqual(deps.pushedSlugs, []);
  });

  it("protects nothing when there are no unsent edits", async () => {
    const protection = await pullProtectionFor(calendarCollection("mirror", false), "/ws", protectionDeps());
    assert.equal(protection?.size, 0);
  });

  // The regression that would make this fix worse than the bug it closes. Every
  // record of a non-autoPush collection now runs through `unsentLocalEdits`, so
  // if what the PULL writes did not compare equal to the baseline built from the
  // SAME event, every record would be protected and the pull would freeze whole.
  // Both sides go through `toCollectionRecord`, which is what makes "unchanged"
  // mean exactly "the pull would produce this" — pinned here with the real
  // functions, since the deps above are fakes.
  it("reads a record the pull just wrote as having no unsent edit", () => {
    const map = { title: "summary", on: "start", until: "end", colour: "colorId" } as const;
    const pulled = toCollectionRecord(event(), map, "gid", recipeFields);
    const baseline = baselineRecord("ev-1", toShadowEvent(event()), pushableMap(map), "gid", recipeFields);
    assert.deepEqual(locallyChangedFields(pulled, baseline, pushableMap(map)), []);
  });

  it("still gives an autoPush collection exactly what its own push could not send", async () => {
    const deps = protectionDeps({
      pushNow: (collection) => Promise.resolve({ kind: "pushed", result: pushResult(collection.slug, ["ev-2"]) }),
    });
    const protection = await pullProtectionFor(calendarCollection("mine", true), "/ws", deps);
    assert.deepEqual([...(protection ?? [])], ["ev-2"]);
  });

  // The #2666 branches must keep working: a push that refuses (a role degraded
  // to reader) or throws leaves every local edit unsent, not just the ones a
  // completed push reported.
  it("falls back to the unsent edits when the push refused to run", async () => {
    const deps = protectionDeps({
      pushNow: () => Promise.resolve({ kind: "read-only", accessRole: "reader" }),
      unsentEdits: () => Promise.resolve(["ev-3"]),
    });
    const protection = await pullProtectionFor(calendarCollection("mine", true), "/ws", deps);
    assert.deepEqual([...(protection ?? [])], ["ev-3"]);
  });

  it("falls back to the unsent edits when the push threw", async () => {
    const deps = protectionDeps({
      pushNow: () => Promise.reject(new Error("network down")),
      unsentEdits: () => Promise.resolve(["ev-4"]),
    });
    const protection = await pullProtectionFor(calendarCollection("mine", true), "/ws", deps);
    assert.deepEqual([...(protection ?? [])], ["ev-4"]);
  });

  // Fail closed, now on the no-autoPush path too: a read that failed says nothing
  // about whether the pull's writes would, so pulling with no protection would
  // destroy exactly what this protects.
  it("answers null when the unsent edits of a non-autoPush collection cannot be read", async () => {
    const deps = protectionDeps({ unsentEdits: () => Promise.reject(new Error("EACCES")) });
    assert.equal(await pullProtectionFor(calendarCollection("mirror", false), "/ws", deps), null);
  });

  it("gives EVERY collection on the calendar an entry, not only the pushing ones", async () => {
    const deps = protectionDeps({ unsentEdits: () => Promise.resolve(["ev-5"]) });
    const unpushed = await pushAndProtect([calendarCollection("mine", true), calendarCollection("mirror", false)], "/ws", deps);
    assert.deepEqual([...unpushed.keys()].sort(), ["mine", "mirror"]);
    assert.deepEqual([...(unpushedFor(unpushed, "mirror") ?? [])], ["ev-5"]);
  });

  // The shared baseline is what makes this load-bearing: advancing it past an
  // unsent edit is what destroys the ability to detect the conflict later.
  it("holds the shared baseline back for a non-autoPush collection's unsent edits", async () => {
    const deps = protectionDeps({ unsentEdits: () => Promise.resolve(["ev-5"]) });
    const unpushed = await pushAndProtect([calendarCollection("mirror", false)], "/ws", deps);
    assert.deepEqual([...allUnpushed(unpushed)], ["ev-5"]);
    assert.deepEqual(shadowUpdates([event({ id: "ev-5" })], allUnpushed(unpushed)), {});
  });
});

// The protected set used to be a snapshot taken when the push finished, so an
// edit made while the window was in flight — minutes of it on a full walk — was
// invisible to it. The pull then wrote Google's value over that edit AND advanced
// the shared baseline past it, after which the next push saw a one-sided edit
// and no conflict to report (#2684). The apply now decides per event, immediately
// before its own write, and reports what it refused so the baseline agrees.
describe("heldBack (#2684 the apply's refusals must reach the baseline)", () => {
  const applied = (slug: string, withheld: string[]): CalendarCollectionSyncResult => ({
    slug,
    written: 0,
    removed: 0,
    unwritable: [],
    withheld,
    errors: [],
  });

  it("holds back what the push could not send AND what the apply refused", () => {
    const unpushed = new Map<string, ReadonlySet<string>>([["mine", new Set(["pushed-conflict"])]]);
    assert.deepEqual([...heldBack(unpushed, [applied("mine", ["edited-mid-window"])])].sort(), ["edited-mid-window", "pushed-conflict"]);
  });

  it("keeps the baseline off every event the apply left alone", () => {
    const held = heldBack(new Map(), [applied("mine", ["ev-1"])]);
    assert.deepEqual(shadowUpdates([event({ id: "ev-1" }), event({ id: "ev-2" })], held), {
      "ev-2": toShadowEvent(event({ id: "ev-2" })),
    });
  });

  it("advances the baseline normally when nothing was withheld", () => {
    const held = heldBack(new Map(), [applied("mine", [])]);
    assert.deepEqual(Object.keys(shadowUpdates([event({ id: "ev-1" })], held)), ["ev-1"]);
  });

  it("unions the refusals of every collection on the calendar", () => {
    const held = heldBack(new Map(), [applied("mine", ["a"]), applied("theirs", ["b"])]);
    assert.deepEqual([...held].sort(), ["a", "b"]);
  });
});

// The rule the apply now runs immediately before each write. It has to answer
// "would writing Google's value here destroy something Google has not seen?" —
// and it must answer NO for a record the pull itself just wrote, or the whole
// pull freezes (#2684).
describe("unsentEditGuard (#2684 the per-event guard)", () => {
  const map = { title: "summary", on: "start", until: "end", colour: "colorId" } as const;
  const schema = { googleCalendar: { map }, primaryKey: "gid", fields: recipeFields } as unknown as LoadedCollection["schema"];
  const synced = event();
  const baseline = { "ev-1": toShadowEvent(synced) };
  const syncedRecord = toCollectionRecord(synced, map, "gid", recipeFields);

  const guard = unsentEditGuard(schema, baseline);

  it("says no for a record that still matches the baseline", () => {
    assert.equal(guard(syncedRecord, synced.id), false);
  });

  it("says yes for a record edited since the baseline was taken", () => {
    assert.equal(guard({ ...syncedRecord, title: "Standup (moved)" }, synced.id), true);
  });

  // A brand-new event this workspace has never held. There is no local edit to
  // lose, so withholding it would just stop the collection ever receiving it.
  it("says no when the workspace holds no baseline for the event", () => {
    assert.equal(unsentEditGuard(schema, {})(syncedRecord, synced.id), false);
  });

  // Local-only columns are the point of `mergeIntoExisting` — the pull keeps
  // them, so they are not a reason to refuse Google's own fields.
  it("ignores a column the map does not name", () => {
    assert.equal(guard({ ...syncedRecord, notes: "call Alice first" }, synced.id), false);
  });

  // Google changing the event is not what this guard is about: it compares the
  // RECORD against the baseline, so a moved event with an untouched record still
  // pulls normally and the conflict check on the next push does its own job.
  it("says no when only Google moved, and the record never diverged", () => {
    const moved = event({ start: "2026-07-19T10:00:00+09:00" });
    assert.equal(guard(syncedRecord, moved.id), false);
  });
});

// Omitting a held-back event is enough on an incremental run — `.push-state.json`
// is merged, not replaced, so the old entry survives. A full re-walk CLEARS the
// baseline first, and there the omission dropped the entry for good: the next
// push then read a conflicted record as a brand-new create, hit Google's
// duplicate-id 409 and refused it instead of reporting the conflict.
// (Observed during Claude review of #2684; no bot flagged it.)
describe("shadowUpdates carry-forward (#2684 a held-back baseline must survive a full re-walk)", () => {
  const held = { "ev-1": toShadowEvent(event({ id: "ev-1", summary: "As Google had it" })) };

  it("re-states the pre-run baseline for a held-back event", () => {
    const updates = shadowUpdates([event({ id: "ev-1", summary: "Google moved on" })], new Set(["ev-1"]), held);
    assert.deepEqual(updates["ev-1"], held["ev-1"]);
  });

  it("never advances a held-back event to what Google now says", () => {
    const updates = shadowUpdates([event({ id: "ev-1", summary: "Google moved on" })], new Set(["ev-1"]), held);
    assert.notDeepEqual(updates["ev-1"], toShadowEvent(event({ id: "ev-1", summary: "Google moved on" })));
  });

  it("still advances everything that was not held back", () => {
    const moved = event({ id: "ev-2" });
    const updates = shadowUpdates([event({ id: "ev-1" }), moved], new Set(["ev-1"]), held);
    assert.deepEqual(updates["ev-2"], toShadowEvent(moved));
  });

  // A held-back id the workspace holds no baseline for — a record created
  // locally and never pushed. There is nothing to carry, and inventing one would
  // make the next push read it as already-synced.
  it("carries nothing for a held-back event with no previous baseline", () => {
    const updates = shadowUpdates([event({ id: "ev-3" })], new Set(["ev-3"]), held);
    assert.equal("ev-3" in updates, false);
  });

  it("behaves as before when no carry-forward is supplied", () => {
    assert.deepEqual(shadowUpdates([event({ id: "ev-1" })], new Set(["ev-1"])), {});
  });
});

// #2684 put the guard in front of the OVERWRITE but not the DELETE, so a
// cancellation in Google still removed a record holding an edit Google had
// never seen — the same silent loss, one branch over (#2688). The guard now
// runs before the status is consulted: "is there something local to lose?"
// outranks "what did Google do to it?".
describe("applyPlanFor (#2688 a cancellation must not outrank a local edit)", () => {
  const edited = (_existing: CollectionItem, eventId: string) => eventId === "ev-edited";
  const cancelled = event({ id: "ev-edited", status: "cancelled" });
  const record = { gid: "ev-edited", title: "mine" };

  it("refuses to delete a record that holds an unsent edit", () => {
    assert.equal(applyPlanFor(record, cancelled, edited), "withhold");
  });

  it("still deletes a record that is in sync with Google", () => {
    assert.equal(applyPlanFor({ gid: "ev-clean" }, event({ id: "ev-clean", status: "cancelled" }), edited), "delete");
  });

  // Cancelling an event this collection never stored is normal, not a loss —
  // `classifyDelete` turns the resulting not-found into a benign skip.
  it("deletes when there is no local record at all", () => {
    assert.equal(applyPlanFor(null, cancelled, edited), "delete");
  });

  it("keeps the #2684 behaviour for a live event with an unsent edit", () => {
    assert.equal(applyPlanFor(record, event({ id: "ev-edited" }), edited), "withhold");
  });

  it("writes a live event over a record that is in sync", () => {
    assert.equal(applyPlanFor({ gid: "ev-clean" }, event({ id: "ev-clean" }), edited), "write");
  });
});

// The baseline half of #2688. `shadowUpdates` emits `null` for a cancelled
// event — dropping the baseline — which is right when the record went with it,
// and wrong when the record was kept: without a baseline the next push reads a
// conflicted record as a brand-new create. The #2684 carry-forward covers this
// once the event is held back, so this pins the two halves together.
describe("shadowUpdates + a withheld cancellation (#2688)", () => {
  const previously = toShadowEvent(event({ id: "ev-1", summary: "As Google had it" }));

  it("keeps the pre-run baseline instead of nulling it when the record was kept", () => {
    const updates = shadowUpdates([event({ id: "ev-1", status: "cancelled" })], new Set(["ev-1"]), { "ev-1": previously });
    assert.deepEqual(updates["ev-1"], previously);
  });

  it("still nulls the baseline when the record really was deleted", () => {
    const updates = shadowUpdates([event({ id: "ev-1", status: "cancelled" })], new Set(), { "ev-1": previously });
    assert.equal(updates["ev-1"], null);
  });
});
