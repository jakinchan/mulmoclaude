# Google Calendar sync — mirror a Google calendar into a collection

A collection can keep itself in sync with one of the user's Google calendars.
Add a `googleCalendar` block to its `schema.json` and the host pulls changed
events on a schedule and writes them as records — **without calling you**. No
tool call, no tokens spent per sync, so hourly syncing is free.

This is the mechanism for *keeping a collection fresh*. For one-off reads and
for deleting events, use the `google` tool — see
[The `google` tool](google.md). There is no bundled calendar collection: you
author the schema when the user asks for one.

## Both directions, but only one of them automatic

| Direction | How | When it runs |
| --- | --- | --- |
| Google → collection | the `googleCalendar` block | hourly, on creation, and on the **Sync** button |
| collection → Google | the **Push to Google** button in the collection view | only when the user clicks it |

There is no automatic write-back and no setting that enables one. If a user
asks for "two-way sync", tell them plainly: the pull is automatic, the push is
a button they press. Do not go looking for a config key for it — there isn't
one, and hunting for it is what makes this conversation go in circles.

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
    "map": { "title": "summary", "on": "start", "until": "end" }
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

Mappable event fields: `summary`, `start`, `end`, `htmlLink`, `colorId`,
`status`.

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

- New or edited events are written, keyed by event id (existing records are
  replaced in place).
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

**Order matters, and this is the one thing to warn users about.** A pull
overwrites a locally edited record as soon as Google reports any change to that
event. So: push first, then sync. Syncing first can discard the edit that was
waiting to be pushed.

What the button does and deliberately does not do:

- **Creates** an event for a record that never came from a sync.
- **Updates** only the fields the user actually changed, so attendees,
  reminders and recurrence rules stay untouched.
- **Never deletes.** A record deleted locally leaves its Google event alone —
  a Google delete removes the event for every attendee and cannot be undone.
  The count is reported so the user knows it was skipped; deleting for real is
  the `google` tool's `calendarDeleteEvent`, after confirming with them.
- **Skips a record edited on both sides** and reports it, rather than picking a
  winner. The user resolves it by editing one side to match.
- Pushes only `summary`, `start`, `end` and `colorId` — `htmlLink` and `status`
  are read-only in Google, so a column mapped to either is ignored.

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
with that reason rather than failing event by event.

## Not for this

A `dataSource` (CSV-backed) collection is read-only and cannot declare
`googleCalendar`. Use a normal `dataPath` collection.
