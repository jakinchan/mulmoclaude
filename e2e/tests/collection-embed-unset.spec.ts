// E2E coverage for an UNSET `embed` field. An `embed` whose `idField`
// points at an OPTIONAL `ref` resolves to an empty target id when the ref
// was never filled in — which the schema contract calls fail-soft "no
// record", not a dangling reference. The detail panel must render that as
// an empty field; only a ref pointing at a record that does NOT exist gets
// the red "missing" card.
//
// Records are opened through the `?selected=` deep link rather than a row
// click: the list row carries the `ref` cell as a link, so a click at the
// row's centre can land on it and navigate to the target collection.

import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const PROJECTS_DETAIL = {
  collection: {
    slug: "projects",
    title: "Projects",
    icon: "folder",
    source: "user",
    schema: {
      title: "Projects",
      icon: "folder",
      dataPath: "data/projects/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        name: { type: "string", label: "Name", required: true },
      },
    },
  },
  items: [{ id: "apollo", name: "Apollo" }],
};

// `projectId` is deliberately NOT required — the case the fix is about.
const TASKS_DETAIL = {
  collection: {
    slug: "tasks",
    title: "Tasks",
    icon: "task_alt",
    source: "user",
    schema: {
      title: "Tasks",
      icon: "task_alt",
      dataPath: "data/tasks/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        title: { type: "string", label: "Title", required: true },
        projectId: { type: "ref", to: "projects", label: "Project" },
        project: { type: "embed", to: "projects", idField: "projectId", label: "Project (embedded)" },
      },
    },
  },
  items: [
    { id: "linked", title: "Linked", projectId: "apollo" },
    { id: "unset", title: "Unset" },
    { id: "blank", title: "Blank", projectId: "" },
    { id: "ghost", title: "Ghost", projectId: "vanished" },
  ],
};

test.describe("collection embed — unset vs dangling", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
    await page.route(
      (url) => url.pathname === "/api/collections/tasks",
      (route) => route.fulfill({ json: TASKS_DETAIL }),
    );
    await page.route(
      (url) => url.pathname === "/api/collections/projects",
      (route) => route.fulfill({ json: PROJECTS_DETAIL }),
    );
  });

  test("a resolved embed still renders the embedded record card", async ({ page }) => {
    await page.goto("/collections/tasks?selected=linked");
    await expect(page.getByTestId("collections-detail")).toBeVisible();
    await expect(page.getByTestId("collections-embed-project")).toBeVisible();
    await expect(page.getByTestId("collections-embed-project-name")).toHaveText("Apollo");
    await expect(page.getByTestId("collections-embed-unset-project")).toHaveCount(0);
  });

  for (const recordId of ["unset", "blank"]) {
    test(`an unset embed (${recordId} idField) renders the empty-field glyph, not the missing card`, async ({ page }) => {
      await page.goto(`/collections/tasks?selected=${recordId}`);
      await expect(page.getByTestId("collections-detail")).toBeVisible();
      await expect(page.getByTestId("collections-embed-unset-project")).toHaveText("—");
      await expect(page.getByTestId("collections-embed-missing-project")).toHaveCount(0);
      await expect(page.getByTestId("collections-embed-project")).toHaveCount(0);
    });
  }

  test("an embed pointing at a deleted record still reports it as missing", async ({ page }) => {
    await page.goto("/collections/tasks?selected=ghost");
    await expect(page.getByTestId("collections-detail")).toBeVisible();
    await expect(page.getByTestId("collections-embed-missing-project")).toContainText("vanished");
    await expect(page.getByTestId("collections-embed-unset-project")).toHaveCount(0);
  });
});
