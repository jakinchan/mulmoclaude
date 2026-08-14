// E2E for the Collections index search box: a substring over title + slug
// narrows the card grid, ANDed with the Editable/Data chip facet. The chips
// only render when a read-only collection exists; the search box has no such
// condition, so it is the narrowing available before anything is classified.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const COLLECTIONS_LIST = {
  collections: [
    { slug: "tasks", title: "Tasks", icon: "task_alt", source: "project" },
    { slug: "task-templates", title: "Task Templates", icon: "content_copy", source: "project" },
    { slug: "clients", title: "顧客", icon: "contact_page", source: "user" },
    { slug: "stock-quotes", title: "Stock Quotes", icon: "trending_up", source: "user", readonly: true },
  ],
};

async function mockCollections(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/collections",
    (route) => route.fulfill({ json: COLLECTIONS_LIST }),
  );
}

const cardCount = (page: Page): Promise<number> => page.locator('[data-testid^="collections-index-card-"]').count();

test.describe("collections index search", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
    await mockCollections(page);
    await page.goto("/collections");
    await expect(page.getByTestId("collections-index-card-tasks")).toBeVisible();
  });

  test("a substring narrows the grid to the matching cards", async ({ page }) => {
    await page.getByTestId("collections-index-search").fill("task");
    await expect(page.getByTestId("collections-index-card-tasks")).toBeVisible();
    await expect(page.getByTestId("collections-index-card-task-templates")).toBeVisible();
    await expect(page.getByTestId("collections-index-card-clients")).toHaveCount(0);
    expect(await cardCount(page)).toBe(2);
  });

  test("the match is case-insensitive, hits the slug, and works on a non-ASCII title", async ({ page }) => {
    const search = page.getByTestId("collections-index-search");
    await search.fill("STOCK");
    await expect(page.getByTestId("collections-index-card-stock-quotes")).toBeVisible();
    // "k-qu" appears in the slug only — never in a title.
    await search.fill("k-qu");
    await expect(page.getByTestId("collections-index-card-stock-quotes")).toBeVisible();
    await search.fill("顧");
    await expect(page.getByTestId("collections-index-card-clients")).toBeVisible();
    expect(await cardCount(page)).toBe(1);
  });

  test("no match shows the empty state, and clearing restores every card", async ({ page }) => {
    await page.getByTestId("collections-index-search").fill("nothing-matches-this");
    await expect(page.getByTestId("collections-index-no-matches")).toBeVisible();
    expect(await cardCount(page)).toBe(0);

    await page.getByTestId("collections-index-search-clear").click();
    await expect(page.getByTestId("collections-index-no-matches")).toHaveCount(0);
    expect(await cardCount(page)).toBe(4);
  });

  test("the search ANDs with the Data chip", async ({ page }) => {
    await page.getByTestId("collections-filter-data").click();
    expect(await cardCount(page)).toBe(1);

    await page.getByTestId("collections-index-search").fill("tasks");
    await expect(page.getByTestId("collections-index-no-matches")).toBeVisible();

    // The empty-state link clears BOTH narrowings — either one can be the
    // reason the grid went empty.
    await page.getByTestId("collections-index-no-matches").getByRole("button").click();
    expect(await cardCount(page)).toBe(4);
  });
});
