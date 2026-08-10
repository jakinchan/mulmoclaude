# fix #2850 — a googleCalendar collection never backfills the existing calendar

## The report

[#2850](https://github.com/receptron/mulmoclaude/issues/2850): a `googleCalendar`
collection's initial full-history sync stalls after writing a handful of records
(0, 1, ~21) on a real, dense, multi-year primary calendar. No error is shown
anywhere; pressing **Sync** again adds nothing. Only events created or edited
*after* the stall keep arriving. The reporter recreated the collection six times
and fixed two real event-level blockers along the way, and it stalled again each
time at a different point.

## Root cause

**The calendar sync token is keyed by `calendarId` alone, so it is shared by
every consumer — and whoever walks the calendar first leaves the next collection
resuming from a cursor it never consumed.**

A sync token is a claim about *which events the consumer already holds*. The
store (`calendarSyncStore.ts`) keys it by canonical calendar id and nothing else,
so it is really a claim about the *calendar*, shared workspace-wide. Two
consumers reach it:

- `packages/core/src/google/collectionSync.ts` — the collection mirror.
- `packages/plugins/google-plugin/src/core/dispatch.ts:85` — the standalone
  `google` tool's `kind: "calendarSync"`, which walks the calendar, **stores the
  token**, and throws the events away (it only returns a summary to the LLM).

Two ways a fresh collection ends up behind a consumed cursor, both in the
reporter's timeline:

- **A.** The reporter ran the `google` tool's `calendarSync` to prove the grant
  worked (their step 2 — "*stored a valid token*"). From then on every
  collection on that calendar started from that cursor.
- **B.** Another collection on the same calendar already synced. A second
  collection created later inherits the first one's cursor.

Both then hit the same two doors:

- `syncNewCalendarCollections` (the on-create first sync, #2427) treats **"the
  calendar has no token"** as its only signal for "this has never synced"
  (`unsyncedGroups`). A token exists ⇒ the new collection's first sync **never
  runs at all**, and it returns before logging anything — which is exactly the
  reporter's "no `google`/`calendar`/`sync` entries at all".
- The **Sync** button (`syncCalendarForCollection`) *does* run, loads the stored
  token, and issues an **incremental** request. Google answers with the delta
  since that cursor — a handful of events — the collection writes them, saves
  the new token, and reports success with **zero errors**. Every later click
  returns another empty delta.

Reproduced end-to-end against the real pipeline with a stubbed Google
(`written`/records shown per Sync click, 2000-event calendar):

```text
### Case A — the standalone `google` tool synced first
  tool stored a token for: primary
  on-create first sync ran for: (NOTHING — skipped)
  Sync click 1: records=1/2000  errorsShownToUser=0
  Sync click 2: records=1/2000  errorsShownToUser=0
  Sync click 3: records=1/2000  errorsShownToUser=0

### Case B — a second collection created on a calendar that already synced
  cal-b1 (first collection) records=2000/2000
  on-create first sync ran for: (NOTHING — skipped)
  Sync click 1: cal-b2 records=2/2000  errorsShownToUser=0
  Sync click 2: cal-b2 records=2/2000  errorsShownToUser=0
  Sync click 3: cal-b2 records=2/2000  errorsShownToUser=0
```

Case B is a plain, easily-hit bug on its own: **the second calendar collection a
user asks for is permanently empty**, with no error.

#2428 fixed one instance of this family (a *deleted* collection's token
outliving it) at the `deleteCollection` call site. The general shape — a token
that outlives, or precedes, the records it claims to describe — was left open.

## A second, independent defect found while investigating

`syncCalendarEvents` (`calendar.ts:345`) walks pages under a runaway guard of
`MAX_EVENT_SYNC_PAGES = 200`. When the guard fires with `nextPageToken` still
pending it returns `{ events, fullResyncRequired: false }` — **byte-identical to
a completed walk**. The caller applies a partial set, reports success, and shows
nothing. `nextSyncToken` only appears on Google's last page, so the token is
never stored either and every later Sync repeats the same truncated walk.

Google [documents](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
that a page "may be less than this value, **or none at all**, even if there are
more events matching the query", and `singleEvents=true` with no time window
expands unbounded recurrences across decades — so the guard is reachable on a
real calendar, not just in theory. Reproduced:

```text
=== 5000 events, google serves 8/page ===
run 1: written=1600 recordsOnDisk=1600/5000 pageRequests=200 errorsShownToUser=0 token={}
run 2: written=1600 recordsOnDisk=1600/5000 pageRequests=200 errorsShownToUser=0 token={}
```

Not the reporter's trigger, but the same symptom class, and it would mask the
fix below the moment a big calendar hits it. Fixed here for that reason.

## The fix

### 1. A collection must be backfilled before it may sync incrementally

Record the backfill **next to the records it describes**, not in the shared
calendar state: `<dataDir>/.calendar-sync.json`, holding the canonical calendar
id the backfill covered. That placement is the point — the marker and the
records reset together, so deleting a collection's data (however it is deleted,
including by hand) correctly asks for a new backfill, and no cross-file cleanup
has to stay in step. It mirrors why the sync token itself lives inside the
workspace rather than next to the OAuth material.

`syncCalendarGroupNow` ignores the stored token and walks in full whenever **any**
collection in the group still needs a backfill. The window fans out to the whole
group as it already does (upserts, so it is harmless for the collections that
were already current), and each collection is marked only after a window that
fully landed.

The push baseline is deliberately **not** cleared for this walk, unlike
`restartFullSync`: a 410 means the stored state may be wrong, whereas a backfill
is additive and the other collections' baselines are still true.

`syncNewCalendarCollections` switches to the same signal, so the on-create first
sync fires for a collection on an already-synced calendar.

### 2. The standalone `google` tool gets its own cursor

The tool's `calendarSync` is a conversational "what changed" report; the
collection sync is a persistent mirror. They are different consumers of the same
calendar and must not eat each other's windows. Namespaced as `tool:<calendarId>`
in the same file.

One-off cost: an existing tool cursor is orphaned, so the next `calendarSync`
call walks once more. Cheap, and it cannot lose anything.

### 3. A truncated walk must not read as a completed one

`CalendarSyncResult` gains `pagesExhausted`. The collection sync reports it to
the user and withholds the backfill marker, so the collection keeps asking for a
complete walk. Named `pagesExhausted`, not `truncated`, because the tool's reply
already uses `truncated` for its capped event sample.

The report is added **after** the token/baseline gate, not routed through it.
Routing it through looked right and was wrong: a short fetch is not a failed
write, so the events that did arrive are Google's own and landed correctly.
Holding their baseline back freezes them — a record with no baseline reads as an
unsent local edit, which the next pull then refuses to touch (#2683) — and the
collection stops making progress entirely. Measured, not reasoned: the first cut
wrote 1600 records on run 1 and then 0 on every run after. Nothing is needed
from the gate anyway, because `nextSyncToken` appears only on Google's last page
— a truncated walk has no token to advance.

## Out of scope (recorded, not fixed here)

- **Blocker #1 in the issue** — an event id starting with `_` (derived from an
  imported iCalUID) can never be stored: `SAFE_RECORD_ID_PATTERN` requires the
  first and last character to be alphanumeric. It is classified `unwritable`, so
  the token advances past it and the event is never seen again. Fixing it needs
  a reversible record-id encoding plus a migration for existing records — its own
  change.
- **A mid-walk page failure discards the whole walk.** `syncCalendarEvents`
  buffers every page and rethrows, so a failure on page N loses pages 1..N-1 and
  the walk can never complete on a calendar flaky enough to fail once. Wants
  page-at-a-time application.
- **`pushCollectionNow` rewrites the shared push-state file once per record**
  (`collectionPush.ts`), under a cross-process lock, on a file that grows with
  the record count — O(N²) I/O for an `autoPush` collection.
- **The initial full sync sends no `timeMin`.** The code comment and
  `google-calendar-collection.md` both say Google forbids a date window with
  incremental sync; Google's own
  [sync guide](https://developers.google.com/workspace/calendar/api/guides/sync)
  says the opposite for the *initial* full sync ("you may want to limit your full
  sync to only a certain date range") — it is only the incremental request that
  must not repeat the filter. Bounding it would cut the unbounded-recurrence
  expansion that produced the reporter's blocker #2. It changes what "all dates"
  means for existing users, so it needs its own decision.

## Steps

1. `plans/fix-2850-calendar-collection-backfill.md` (this file).
2. `calendarBackfillState.ts` — read/write/needs-backfill over `<dataDir>/.calendar-sync.json`.
3. `collectionSync.ts` — force a full walk while any collection needs a backfill; mark on success; switch the on-create trigger to the same signal.
4. `calendar.ts` — `pagesExhausted`; `collectionSync.ts` + the `google` tool report it.
5. Namespace the `google` tool's token.
6. Tests: the two reproduced cases, the marker rules, the truncation report.
7. `yarn format` / `lint` / `typecheck` / `build` / `test`.
