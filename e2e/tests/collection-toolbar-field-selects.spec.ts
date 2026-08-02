// E2E for the two field choosers in the collection toolbar: which date
// field anchors the calendar grid, and which enum field groups the kanban
// board. Both `<select>`s render ONLY when the schema carries more than one
// field of that type — a single date / enum field needs no chooser — and no
// other spec feeds a two-of-each schema, so neither control had coverage.
//
// Each assertion reads the GRID (which day cell holds the chip / which
// columns exist), never the select's own value. A `<select>` keeps showing
// whatever the user picked even when its change handler drops the event on
// the floor, so its value proves nothing; only the re-anchored calendar and
// the re-grouped board prove the emit reached the parent.
//
// Records sit in the *current* month so they land on the calendar's
// default-visible grid without mocking the clock.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const today = new Date();
const monthPrefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
const DUE_DAY = `${monthPrefix}-15`;
const STARTED_DAY = `${monthPrefix}-05`;

const TASKS = {
  collection: {
    slug: "toolbar-fields",
    title: "Toolbar Fields",
    icon: "checklist",
    source: "user",
    schema: {
      title: "Toolbar Fields",
      icon: "checklist",
      dataPath: "data/toolbar-fields/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        name: { type: "string", label: "Name", required: true },
        // Two date fields → the calendar anchor chooser appears.
        due: { type: "date", label: "Due" },
        startedOn: { type: "date", label: "Started" },
        // Two enum fields → the kanban group chooser appears. Their values
        // are disjoint so a column testid names the grouping field.
        status: { type: "enum", label: "Status", values: ["todo", "doing", "done"] },
        priority: { type: "enum", label: "Priority", values: ["low", "high"] },
      },
      displayField: "name",
      calendarField: "due",
    },
  },
  items: [{ id: "a", name: "Task A", due: DUE_DAY, startedOn: STARTED_DAY, status: "doing", priority: "high" }],
};

async function setup(page: Page): Promise<void> {
  await mockAllApis(page);
  await page.route(
    (url) => url.pathname === "/api/collections/toolbar-fields",
    (route) => route.fulfill({ json: TASKS }),
  );
}

test.describe("collection toolbar field choosers", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("the calendar anchor chooser re-anchors the grid to the picked date field", async ({ page }) => {
    await page.goto("/collections/toolbar-fields");
    await page.getByTestId("collection-view-toggle-calendar").click();
    await expect(page.getByTestId("collection-calendar")).toBeVisible();

    const anchor = page.getByTestId("collection-calendar-field");
    await expect(anchor).toBeVisible();
    await expect(anchor).toHaveValue("due");

    // Anchored on `due`: the chip sits in the 15th's cell, not the 5th's.
    await expect(page.getByTestId(`collection-calendar-day-${DUE_DAY}`).getByTestId("collection-calendar-chip-a")).toBeVisible();
    await expect(page.getByTestId(`collection-calendar-day-${STARTED_DAY}`).getByTestId("collection-calendar-chip-a")).toHaveCount(0);

    // Re-anchor on `startedOn`: the chip moves to the 5th.
    await anchor.selectOption("startedOn");
    await expect(page.getByTestId(`collection-calendar-day-${STARTED_DAY}`).getByTestId("collection-calendar-chip-a")).toBeVisible();
    await expect(page.getByTestId(`collection-calendar-day-${DUE_DAY}`).getByTestId("collection-calendar-chip-a")).toHaveCount(0);
  });

  test("the kanban group chooser re-groups the board by the picked enum field", async ({ page }) => {
    await page.goto("/collections/toolbar-fields");
    await page.getByTestId("collection-view-toggle-kanban").click();
    await expect(page.getByTestId("collection-kanban")).toBeVisible();

    const group = page.getByTestId("collection-kanban-field");
    await expect(group).toBeVisible();
    await expect(group).toHaveValue("status");

    // Grouped by `status`: columns are the status values.
    await expect(page.getByTestId("collection-kanban-column-doing")).toBeVisible();
    await expect(page.getByTestId("collection-kanban-column-high")).toHaveCount(0);

    // Re-group by `priority`: the columns become the priority values.
    await group.selectOption("priority");
    await expect(page.getByTestId("collection-kanban-column-high")).toBeVisible();
    await expect(page.getByTestId("collection-kanban-column-doing")).toHaveCount(0);
  });
});
