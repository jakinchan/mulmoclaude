// E2E coverage for the value-based external-URL rendering in
// CollectionView (feat/collection-completion-bell). Any string field
// whose value starts with `http://` or `https://` renders as a
// `target="_blank"` anchor in both the list table and the detail
// view; non-URL string values fall through to the plain-text renderer.
//
// The list-row anchor uses `@click.stop` so clicking the link only
// opens the new tab — it must NOT also bubble into the row click that
// opens the detail panel. This file pins that boundary so a future
// refactor can't quietly regress it.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const READING_LIST = {
  collection: {
    slug: "reading-list",
    title: "Reading List",
    icon: "bookmark",
    source: "user",
    schema: {
      title: "Reading List",
      icon: "bookmark",
      dataPath: "data/reading-list/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        url: { type: "string", label: "URL", required: true },
        notes: { type: "string", label: "Notes" },
        read: { type: "boolean", label: "Read", required: true },
      },
      completionField: "read",
      completionDoneValues: ["true"],
    },
  },
  items: [
    { id: "anthropic-blog", url: "https://www.anthropic.com/news", notes: "Skim the latest post", read: false },
    { id: "non-url-row", url: "not actually a url", notes: "just text", read: false },
  ],
};

async function mockCollection(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/collections/reading-list",
    (route) => route.fulfill({ json: READING_LIST }),
  );
}

test.describe("collection URL links", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
    await mockCollection(page);
  });

  test("list row renders an http(s) URL value as a new-tab link", async ({ page }) => {
    await page.goto("/collections/reading-list");
    const link = page.getByTestId("collections-url-link-url-anthropic-blog");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://www.anthropic.com/news");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("list row falls back to plain text for non-URL string values", async ({ page }) => {
    await page.goto("/collections/reading-list");
    // The non-URL row is in the table…
    await expect(page.getByTestId("collections-row-non-url-row")).toBeVisible();
    // …but it has no anchor element for the `url` column — the fallback
    // span renders the raw string instead.
    await expect(page.getByTestId("collections-url-link-url-non-url-row")).toHaveCount(0);
  });

  test("detail view renders an http(s) URL value as a new-tab link", async ({ page }) => {
    await page.goto("/collections/reading-list");
    // Click the ID cell rather than the row's geometric center — the
    // center may land on the URL link cell, whose `@click.stop` would
    // (correctly) block the row's openView handler. This test is about
    // the detail-side rendering; the click-boundary itself is pinned
    // by the next test below.
    await page.getByTestId("collections-row-anthropic-blog").getByText("anthropic-blog").click();
    await expect(page.getByTestId("collections-detail")).toBeVisible();
    const link = page.getByTestId("collections-detail-url-url");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://www.anthropic.com/news");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("clicking a URL link in the list does NOT open the row's detail panel", async ({ page }) => {
    // Stub `window.open` BEFORE navigating — `addInitScript` only runs
    // on subsequent navigations, so the order matters. The override
    // prevents the new tab from actually opening; we only need to
    // verify the click doesn't bubble into the row handler.
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).open = () => null;
    });
    await page.goto("/collections/reading-list");
    await page.getByTestId("collections-url-link-url-anthropic-blog").click();
    // Detail panel is the modal-style overlay opened by the row click.
    // If `@click.stop` is missing, this would be visible.
    await expect(page.getByTestId("collections-detail")).toHaveCount(0);
  });
});
