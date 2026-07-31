# Google Calendar sync — mirror a Google calendar into a collection

A collection can keep itself in sync with one of the user's Google calendars.
Add a `googleCalendar` block to its `schema.json` and the host pulls changed
events on a schedule and writes them as records — **without calling you**. No
tool call, no tokens spent per sync, so hourly syncing is free.

This is the mechanism for *keeping a collection fresh*. For one-off reads and
for deleting events, use the `google` tool — see
[The `google` tool](google.md). There is no bundled calendar collection: you
author the schema when the user asks for one.

## Both directions

| Direction | How | When it runs |
| --- | --- | --- |
| Google → collection | the `googleCalendar` block | hourly, on creation, and on the **Sync** button |
| collection → Google | the **Push to Google** button | whenever the user clicks it |
| collection → Google | `"autoPush": true` in the block | hourly, immediately before each pull |

When a user asks for "two-way sync", `autoPush` is the answer: set it and each
scheduled run pushes local edits up and then pulls Google's changes down, as one
cycle. Without it the pull is automatic and the push is a button they must
remember to press — which is why the order used to matter so much.

It is **opt-in and off by default**, and that is deliberate: a push writes to a
calendar other people may be reading, so turning it on is the user's call. Ask
before you add it.

## Requirements

The user's Google account must be linked (`google` tool, `kind: "status"`). If
it isn't, sync silently does nothing until they link it in settings.

## The block

```jsonc
{
  "fields": {
    "gid":   { "type": "string",   "label": "ID",   "primary": true },
    "title": { "type": "string",   "label": "Event" },
    "on":    { "type": "datetime", "label": "Start" },
    "until": { "type": "datetime", "label": "End" }
  },
  "primaryKey": "gid",
  "displayField": "title",
  "calendarField": "on",
  "calendarEndField": "until",
  "dataPath": "data/collections/my-schedule/items",

  "googleCalendar": {
    "calendarId": "primary",
    "map": { "title": "summary", "on": "start", "until": "end" },
    "autoPush": true
  }
}
```

- `calendarId` — the calendar to read. `"primary"` (as in the example) and
  omitting the key entirely both mean the user's primary calendar. For any
  other calendar, get its id from the `google` tool
  (`kind: "calendarListCalendars"`).
- `map` — **your field name → the Google event field**. Pick whatever field
  names suit the collection; the map absorbs the difference. Map at least one
  field: an empty map syncs records that carry only the event id, so the user
  would see rows with no content.
- `autoPush` — push local edits on the sync schedule, just before each pull.
  Omit it (the default) and the push stays a button. See "Both directions".

Mappable event fields: `summary`, `start`, `end`, `description`, `location`,
`htmlLink`, `colorId`, `status`.

`description` is the event body, and Google stores limited **HTML** in it. It is
kept verbatim — mirroring it through a plain-text field and pushing it back would
strip the user's formatting. Give it a `text` field, and do not "clean it up" on
the way in.

Mapping a column the user already filled by hand (a `notes` column, say) onto
`description` means the next push sends that text to Google. That is usually what
they want, but say so before you write the map.

## The primary field is the event id

Do **not** map the primary field. It always receives the Google event id, which
is what lets a re-sync update an existing record instead of duplicating it.
Declaring it in `map` is a schema error.

Use `datetime` (not `date`) for start/end when events have real clock times —
the calendar day view then draws each record as a proportional time block.

## When sync runs

- **On creation** — the first sync starts as soon as the schema lands, so the
  collection is not empty while the user waits for the schedule. The same
  applies when you add a `googleCalendar` block to an existing collection.
- **Hourly** after that, in the background.
- **On demand** — the collection view has a Sync button. Tell the user about it
  if they want the calendar refreshed right now.

## What sync does

- New or edited events are written, keyed by event id. Only the mapped columns
  are overwritten: a column the map does not name (a local note the user keeps
  next to the event) survives the pull. The flip side is that a field you REMOVE
  from `map` keeps its last synced value rather than disappearing.
- Events deleted in Google are **deleted** from the collection.
- Only what changed since the last run is fetched, so a big calendar stays
  cheap after the first sync.
- The first run walks the whole calendar to establish a starting point. Note
  this covers **all** dates — Google does not allow a date window together with
  incremental sync — so a calendar with years of history produces a lot of
  records on that first pass.

Records are ordinary collection records: the user can open, filter, and view
them like any other.

## Pushing local work back — the Push to Google button

The collection view has a **Push to Google** button next to Sync. It creates
events for records added locally and updates events for records edited locally.

**Order matters when the push is manual.** A pull overwrites a locally edited
record as soon as Google reports any change to that event, so: push first, then
sync. Syncing first can discard the edit that was waiting to be pushed. This is
exactly the trap `autoPush` closes — it runs the two in that order for the user.

What the button does and deliberately does not do:

- **Creates** an event for a record that never came from a sync.
- **Updates** only the fields the user actually changed, so attendees,
  reminders and recurrence rules stay untouched.
- **Never deletes.** A record deleted locally leaves its Google event alone —
  a Google delete removes the event for every attendee and cannot be undone.
  The count is reported so the user knows it was skipped; deleting for real is
  the `google` tool's `calendarDeleteEvent`, after confirming with them.
- **Skips a record edited on both sides** and reports it, rather than picking a
  winner. The user resolves it by editing one side to match. Under `autoPush`
  the pull that follows leaves that record alone too, so the local edit is not
  destroyed while it waits — the cost is that the record stays behind Google
  until someone resolves it, and the host logs which records those are.
- Pushes `summary`, `start`, `end`, `description`, `location` and `colorId` —
  everything the pull can read except `htmlLink` and `status`, which are
  read-only in Google, so a column mapped to either is ignored.

Reasons a record can be reported as skipped:

- **Its record id cannot be a Google event id.** Google requires 5-1024
  characters from `0-9a-v`. Records created through the UI get a valid
  generated id; a semantic id you authored (`team-standup`) cannot be used. Fix
  by recreating the record without setting the primary field.
- **No `start` / `end` is mapped, on a record being CREATED.** An event cannot
  be created without a span. Editing an existing event is unaffected — a changed
  title or colour is patched on its own.
- **The calendar reports no timezone**, and the stored clock carries no offset
  to fall back on.
- **Clearing an event colour** — Google has no way to unset one.

If the user only has `reader` access to the calendar, the whole push is refused
with that reason rather than failing event by event. A calendar the user can
reach by id but has not added to their calendar list has no role to check, so
the push goes ahead and reports Google's own refusal if the write turns out not
to be allowed — being unlisted is not treated as being read-only.

## Not for this

A `dataSource` (CSV-backed) collection is read-only and cannot declare
`googleCalendar`. Use a normal `dataPath` collection.
