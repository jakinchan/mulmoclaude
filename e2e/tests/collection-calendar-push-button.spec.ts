// E2E coverage for the Push to Google button (#2598).
//
// Two things are pinned. First the gate: the button exists only for a
// `googleCalendar` collection, because pushing writes to a calendar other people
// may read — widening it to every collection is the obvious way to break it.
//
// Second, that a setup failure is SHOWN. The push route answers HTTP 200 with an
// `errors` array for an unlinked account or a read-only calendar, so a client
// that only read the counts would render "0 created" and send the user auditing
// their records instead of their settings.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const baseSchema = {
  title: "My Schedule",
  icon: "event",
  dataPath: "data/collections/my-schedule/items",
  primaryKey: "gid",
  fields: {
    gid: { type: "string", label: "ID", primary: true, required: true },
    title: { type: "string", label: "Event" },
  },
};

const CALENDAR_COLLECTION = {
  collection: {
    slug: "my-schedule",
    title: "My Schedule",
    icon: "event",
    source: "user",
    schema: { ...baseSchema, googleCalendar: { calendarId: "primary", map: { title: "summary" } } },
  },
  items: [{ gid: "ev-1", title: "Standup" }],
};

const PLAIN_COLLECTION = {
  collection: { slug: "my-schedule", title: "My Schedule", icon: "event", source: "user", schema: baseSchema },
  items: [{ gid: "ev-1", title: "Standup" }],
};

const emptyPush = { pushed: true, created: 0, updated: 0, conflicts: 0, localDeletes: 0, skipped: [], errors: [] };

async function mockCollection(page: Page, payload: unknown): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/collections/my-schedule",
    (route) => route.fulfill({ json: payload }),
  );
}

async function mockPush(page: Page, body: unknown, calls: string[]): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/collections/my-schedule/calendar-push",
    (route) => {
      calls.push(route.request().method());
      return route.fulfill({ json: body });
    },
  );
}

test.describe("collection → Google Calendar push button", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("posts to the calendar-push route and reports what happened", async ({ page }) => {
    await mockCollection(page, CALENDAR_COLLECTION);
    const calls: string[] = [];
    await mockPush(page, { ...emptyPush, created: 1, updated: 2 }, calls);

    await page.goto("/collections/my-schedule");
    const push = page.getByTestId("collections-push-calendar");
    await expect(push).toBeVisible();
    // Distinct from Sync: which direction the data moved must never be ambiguous.
    await expect(push).toHaveText(/Push to Google/);
    await expect(page.getByTestId("collections-refresh-feed")).toBeVisible();

    await push.click();
    await expect.poll(() => calls).toEqual(["POST"]);
    await expect(page.getByText(/1 created, 2 updated/)).toBeVisible();
  });

  test("surfaces an unlinked-account error instead of a silent zero-count success", async ({ page }) => {
    await mockCollection(page, CALENDAR_COLLECTION);
    const calls: string[] = [];
    await mockPush(page, { ...emptyPush, errors: ["no Google account is linked on this host — link it in Settings → Google"] }, calls);

    await page.goto("/collections/my-schedule");
    await page.getByTestId("collections-push-calendar").click();
    await expect.poll(() => calls).toEqual(["POST"]);
    await expect(page.getByText(/no Google account is linked/)).toBeVisible();
  });

  test("surfaces a per-record skip reason", async ({ page }) => {
    await mockCollection(page, CALENDAR_COLLECTION);
    const calls: string[] = [];
    await mockPush(page, { ...emptyPush, skipped: ["team-standup: the record id cannot be used as a Google event id"] }, calls);

    await page.goto("/collections/my-schedule");
    await page.getByTestId("collections-push-calendar").click();
    await expect.poll(() => calls).toEqual(["POST"]);
    await expect(page.getByText(/cannot be used as a Google event id/)).toBeVisible();
  });

  test("shows no push button for a collection that declares no googleCalendar", async ({ page }) => {
    await mockCollection(page, PLAIN_COLLECTION);
    await page.goto("/collections/my-schedule");
    await expect(page.getByTestId("collections-chat")).toBeVisible();
    await expect(page.getByTestId("collections-push-calendar")).toHaveCount(0);
  });
});
