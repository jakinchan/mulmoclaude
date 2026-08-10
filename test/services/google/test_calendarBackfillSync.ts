// End-to-end regression tests for #2850, driven through `syncCalendarGroup`
// against a stubbed Google and a real temp workspace.
//
// Deliberately NOT unit tests of the decision helpers — those live in
// `test_calendarBackfillState.ts`. What is pinned here is the wiring, because
// every #2850 symptom was a wiring bug that each individual piece got right:
// `syncCalendarEvents` reported the truncation, the store held the token, and
// the collection still ended up with a handful of records and no error. A
// future refactor that keeps all the helpers correct can reintroduce the whole
// failure, which is exactly what the Codex review on the fix asked to cover.

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoadedCollection } from "@mulmoclaude/core/collection/server";

// `os.homedir()` reads $HOME on POSIX and %USERPROFILE% on Windows, and CI runs
// both. Set before the engine is imported so the OAuth token below is the one
// it finds; getting this wrong makes the suite pass on macOS and hang on the
// Windows matrix reaching for a real Google grant.
const HOME_ENV_KEYS = ["HOME", "USERPROFILE"] as const;
const savedHome = Object.fromEntries(HOME_ENV_KEYS.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;

let root: string;
let fakeHome: string;
let engine: typeof import("@mulmoclaude/core/google");

/** Events Google will serve, and how it pages them. */
let calendarEvents: { id: string; summary: string; start: { dateTime: string }; end: { dateTime: string }; status: string }[] = [];
let itemsPerPage = 2500;
/** Set for a token request, so an incremental window can differ from a full one. */
let deltaEventIds: string[] = [];

const quiet = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

const pad = (value: number): string => String(value).padStart(2, "0");

const makeEvent = (index: number) => {
  const day = new Date(Date.UTC(2020, 0, 1) + index * 24 * 3_600_000);
  const clock = (minute: string) => `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T09:${minute}:00Z`;
  return {
    id: `evt${index.toString(32).padStart(8, "0")}aaaa`,
    summary: `Event ${index}`,
    start: { dateTime: clock("00") },
    end: { dateTime: clock("30") },
    status: "confirmed",
  };
};

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** A Google that pages the way the real one is documented to: a page may hold
 *  far fewer events than `maxResults`, and only the LAST page carries
 *  `nextSyncToken`. A `syncToken` request answers with the delta alone. */
function stubGoogle(): void {
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/calendar/v3/users/me/calendarList") {
      return jsonResponse({ items: [{ id: "me@example.com", primary: true, accessRole: "owner", timeZone: "Asia/Tokyo" }] });
    }
    if (url.searchParams.get("syncToken")) {
      return jsonResponse({
        items: deltaEventIds.map((wanted) => calendarEvents.find((event) => event.id === wanted)).filter(Boolean),
        nextSyncToken: "tok-delta",
      });
    }
    const offset = Number(url.searchParams.get("pageToken") ?? 0);
    const slice = calendarEvents.slice(offset, offset + itemsPerPage);
    const next = offset + slice.length;
    return jsonResponse({ items: slice, ...(next < calendarEvents.length ? { nextPageToken: String(next) } : { nextSyncToken: `tok-${next}` }) });
  }) as typeof fetch;
}

function writeCollection(slug: string): void {
  const skillDir = path.join(root, ".claude", "skills", slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${slug}\ndescription: calendar\n---\n\ncalendar\n`);
  writeFileSync(
    path.join(skillDir, "schema.json"),
    JSON.stringify({
      title: slug,
      icon: "event",
      fields: {
        gid: { type: "string", label: "ID", primary: true },
        title: { type: "string", label: "Event" },
        on: { type: "datetime", label: "Start" },
        until: { type: "datetime", label: "End" },
      },
      primaryKey: "gid",
      displayField: "title",
      calendarField: "on",
      calendarEndField: "until",
      dataPath: `data/collections/${slug}/items`,
      googleCalendar: { calendarId: "primary", map: { title: "summary", on: "start", until: "end" } },
    }),
  );
}

const itemsDir = (slug: string): string => path.join(root, "data", "collections", slug, "items");

/** Records only — the backfill marker is dot-prefixed and is not one. */
const recordCount = (slug: string): number => {
  try {
    return readdirSync(itemsDir(slug)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).length;
  } catch {
    return 0;
  }
};

const hasBackfillMarker = (slug: string): boolean => {
  try {
    return readdirSync(itemsDir(slug)).includes(".calendar-sync.json");
  } catch {
    return false;
  }
};

const storedTokens = (): string[] => {
  try {
    return Object.keys(JSON.parse(readFileSync(path.join(root, "data", "calendar", ".sync-state.json"), "utf-8")).tokens ?? {});
  } catch {
    return [];
  }
};

/** Discovery is the engine's own, so the test drives exactly what the app does. */
async function collectionsFor(slugs: readonly string[]): Promise<LoadedCollection[]> {
  const { discoverCollections } = await import("@mulmoclaude/core/collection/server");
  const all = await discoverCollections({ workspaceRoot: root });
  return slugs.map((slug) => {
    const found = all.find((collection) => collection.slug === slug);
    assert.ok(found, `discovery did not find '${slug}' — the fixture schema is wrong, not the code under test`);
    return found;
  });
}

/** `noUncheckedIndexedAccess` is on, and a fixture index that silently went
 *  undefined would make a delta assertion pass for the wrong reason. */
function eventIdAt(index: number): string {
  const event = calendarEvents[index];
  assert.ok(event, `fixture has no event at ${index}`);
  return event.id;
}

const syncGroup = async (slugs: readonly string[]) => await engine.syncCalendarGroup("primary", await collectionsFor(slugs), root);

before(async () => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "cal-sync-home-"));
  HOME_ENV_KEYS.forEach((key) => (process.env[key] = fakeHome));
  mkdirSync(path.join(fakeHome, ".config", "mulmo"), { recursive: true });
  // A broker-issued token whose access token is still valid short-circuits the
  // refresh, so the engine never reaches the network for auth.
  writeFileSync(
    path.join(fakeHome, ".config", "mulmo", "google-token.json"),
    JSON.stringify({ access_token: "fake-access", refresh_token: "fake-refresh", issuedVia: "broker", expiry_date: Date.now() + 3_600_000 }),
  );
  engine = await import("@mulmoclaude/core/google");
  engine.configureGoogleHost({ log: quiet });

  // Bound ONCE — the host slot refuses a second, different binding — and in
  // EXPLICIT-ROOT mode (`workspaceRoot: null`) so each test can own a fresh
  // temp root. That is the stricter choice too: a call that forgot to thread
  // its `workspaceRoot` throws here instead of quietly reading another root.
  const { configureCollectionHost } = await import("@mulmoclaude/core/collection/server");
  configureCollectionHost({
    workspaceRoot: null,
    log: quiet,
    paths: {
      userSkillsDir: () => null,
      projectSkillsDir: (workspaceRoot: string) => path.join(workspaceRoot, ".claude", "skills"),
      feedsRoot: (workspaceRoot: string) => path.join(workspaceRoot, "data", "feeds"),
      skillsStagingDir: (workspaceRoot: string) => path.join(workspaceRoot, "data", "skills"),
      archiveDir: "data/archive",
      collectionsRegistriesConfig: (workspaceRoot: string) => path.join(workspaceRoot, "config", "collections-registries.json"),
    },
    isPresetSlug: () => false,
  });
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cal-sync-ws-"));
  calendarEvents = Array.from({ length: 40 }, (_unused, index) => makeEvent(index));
  itemsPerPage = 2500;
  deltaEventIds = [];
  stubGoogle();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a collection whose calendar already holds someone else's cursor (#2850)", () => {
  // Case A: the reporter ran the standalone `google` tool's calendarSync to
  // prove the grant worked. It walks, stores a token, and throws the events
  // away — after which every collection resumed from a window it never had.
  it("backfills the whole calendar even though a token was already stored", async () => {
    await engine.saveCalendarSyncToken("primary", "tok-from-google-tool", root);
    deltaEventIds = [eventIdAt(7)];
    writeCollection("fresh");

    const [result] = await syncGroup(["fresh"]);

    assert.deepEqual(result?.errors, []);
    assert.equal(recordCount("fresh"), calendarEvents.length, "the whole calendar must land, not the one-event delta");
  });

  // Case B: the second calendar collection a user asks for. Before the fix it
  // inherited the first one's cursor and stayed permanently empty, no error.
  it("backfills a second collection created on an already-synced calendar", async () => {
    writeCollection("first");
    await syncGroup(["first"]);
    assert.equal(recordCount("first"), calendarEvents.length);

    deltaEventIds = [eventIdAt(3), eventIdAt(4)];
    writeCollection("second");
    await syncGroup(["first", "second"]);

    assert.equal(recordCount("second"), calendarEvents.length, "the new collection must receive the history, not a two-event delta");
  });

  // The other half of the contract: once every collection holds the history the
  // sync goes back to being cheap. A backfill that never stopped would walk the
  // whole calendar hourly, forever.
  it("goes incremental again once the collection has been backfilled", async () => {
    writeCollection("filled");
    await syncGroup(["filled"]);
    assert.equal(hasBackfillMarker("filled"), true);

    calendarEvents.push(makeEvent(999));
    deltaEventIds = [eventIdAt(calendarEvents.length - 1)];
    const [second] = await syncGroup(["filled"]);

    assert.deepEqual(second?.errors, []);
    assert.equal(second?.written, 1, "an incremental window applies only the delta");
    assert.equal(recordCount("filled"), calendarEvents.length);
  });
});

describe("a full walk that runs out of pages (#2850)", () => {
  // What Codex asked this branch to prove: the partial window is applied AND
  // reported, while neither the shared token nor the per-collection marker
  // moves — so the collection keeps asking for the rest of its calendar
  // instead of settling into the original silent gap.
  beforeEach(() => {
    // The guard is 200 pages. Google is documented to serve pages far shorter
    // than `maxResults` ("or none at all"), so page count does not track event
    // count — one event per page over a calendar bigger than the guard is that
    // shape at its simplest.
    calendarEvents = Array.from({ length: 250 }, (_unused, index) => makeEvent(index));
    itemsPerPage = 1;
  });

  it("applies the records that did arrive", async () => {
    writeCollection("partial");
    const [result] = await syncGroup(["partial"]);
    assert.ok((result?.written ?? 0) > 0, "a partial walk still writes what it received");
    assert.equal(recordCount("partial"), result?.written);
  });

  it("reports the truncation to the user instead of reading as success", async () => {
    writeCollection("partial");
    const [result] = await syncGroup(["partial"]);
    assert.deepEqual(result?.errors, [engine.PARTIAL_CALENDAR_WINDOW]);
  });

  it("does NOT advance the shared sync token", async () => {
    writeCollection("partial");
    await syncGroup(["partial"]);
    assert.deepEqual(storedTokens(), [], "a partial walk must leave the calendar's cursor untouched");
  });

  it("does NOT write the collection's backfill marker", async () => {
    writeCollection("partial");
    await syncGroup(["partial"]);
    assert.equal(hasBackfillMarker("partial"), false, "a partial copy must keep asking for the rest of the calendar");
  });

  // The whole point of withholding the marker: the next attempt is still a FULL
  // walk, not a delta against a cursor that was never earned.
  it("still walks in full on the next attempt, and completes once the calendar fits", async () => {
    writeCollection("partial");
    await syncGroup(["partial"]);

    itemsPerPage = 2500;
    const [second] = await syncGroup(["partial"]);

    assert.deepEqual(second?.errors, []);
    assert.equal(recordCount("partial"), calendarEvents.length);
    assert.equal(hasBackfillMarker("partial"), true);
    assert.deepEqual(storedTokens(), ["primary"]);
  });
});

describe("the standalone google tool's cursor is separate (#2850)", () => {
  it("a tool cursor does not satisfy a collection, and a collection walk does not overwrite it", async () => {
    await engine.saveCalendarSyncToken(engine.toolCalendarSyncKey("primary"), "tok-tool", root);
    writeCollection("mine");

    await syncGroup(["mine"]);

    assert.equal(recordCount("mine"), calendarEvents.length);
    assert.equal(
      await engine.loadCalendarSyncToken(engine.toolCalendarSyncKey("primary"), root),
      "tok-tool",
      "the tool's cursor must survive a collection walk",
    );
  });
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  // Restoring by assignment: `delete process.env[key]` is a dynamic delete, and
  // an empty string reads the same as unset to `os.homedir()`.
  HOME_ENV_KEYS.forEach((key) => (process.env[key] = savedHome[key] ?? ""));
  rmSync(fakeHome, { recursive: true, force: true });
});
