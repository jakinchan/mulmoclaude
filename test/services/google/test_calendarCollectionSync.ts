// Unit tests for the LLM-free Google Calendar → collection projection
// (#2095). The mapping is the part that silently corrupts data if it drifts:
// the primary field must always carry the Google event id (that is what makes
// a re-sync update instead of duplicate), and only declared fields may be
// written.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anySyncedCollectionSurvives,
  classifyDelete,
  classifyWrite,
  groupByCalendar,
  isUnpushed,
  mergeIntoExisting,
  orphanedCalendarId,
  pullableEvents,
  shadowUpdates,
  toCollectionRecord,
  syncCalendarForCollection,
  unsyncedGroups,
  withKeyedLock,
} from "@mulmoclaude/core/google";
import type { CalendarCollectionSyncResult, CalendarDeclaring, CalendarEventSummary, ManualCalendarSyncDeps } from "@mulmoclaude/core/google";
import { parseIsoDateTime } from "@mulmoclaude/core/collection";
import type { CollectionFieldSpec } from "@mulmoclaude/core/collection";
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
  const syncedResult = (slug: string): CalendarCollectionSyncResult => ({ slug, written: 2, removed: 0, unwritable: [], errors: [] });

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
