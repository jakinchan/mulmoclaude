// E2E for the collections-index display order (#2836): the Slug / Name toggle
// reorders the cards, the choice survives a reload (localStorage), and the
// control stays out of the way when there is nothing to order.
//
// The slugs and titles below deliberately disagree, so each assertion pins a
// real reordering rather than one order that happens to match both keys.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

// Served in an order no client-side comparator would reproduce by accident, so
// the default mode is pinned to "hand back exactly what the server sent" rather
// than to "re-sort by slug and hope it matches" (Codex + Sourcery on #2896).
const COLLECTIONS_LIST = {
  collections: [
    { slug: "beta", title: "Zebra", icon: "bookmark", source: "user" },
    { slug: "alpha", title: "Mango", icon: "bookmark", source: "user" },
    { slug: "gamma", title: "Apple", icon: "bookmark", source: "user" },
  ],
};

const SERVER_ORDER = ["beta", "alpha", "gamma"];
const BY_TITLE = ["gamma", "alpha", "beta"];

async function mockCollections(page: Page, json: unknown = COLLECTIONS_LIST): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/collections",
    (route) => route.fulfill({ json }),
  );
}

/** Slugs in the order the cards are laid out in the DOM. */
async function renderedSlugs(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid^="collections-index-card-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));
  return ids.map((testId) => testId.replace("collections-index-card-", ""));
}

test.describe("collections index display order", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
    await mockCollections(page);
  });

  test("keeps the server order by default and switches to name order on click", async ({ page }) => {
    await page.goto("/collections");
    await expect(page.getByTestId("collections-index-card-beta")).toBeVisible();

    // Default hands back the server's discovery order verbatim, so nothing moves
    // for a user who never touches the toggle.
    expect(await renderedSlugs(page)).toEqual(SERVER_ORDER);
    await expect(page.getByTestId("collections-sort-slug")).toHaveAttribute("aria-pressed", "true");
    // Labels come from the plugin's own i18n bundle; a missing key renders the
    // raw key path instead, which every testid-only assertion would sail past.
    await expect(page.getByTestId("collections-sort")).toContainText("Order");
    await expect(page.getByTestId("collections-sort-title")).toHaveText("Name");

    await page.getByTestId("collections-sort-title").click();

    await expect.poll(() => renderedSlugs(page)).toEqual(BY_TITLE);
    await expect(page.getByTestId("collections-sort-title")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("collections-sort-slug")).toHaveAttribute("aria-pressed", "false");
  });

  test("keeps the chosen order across a reload", async ({ page }) => {
    await page.goto("/collections");
    await page.getByTestId("collections-sort-title").click();
    await expect.poll(() => renderedSlugs(page)).toEqual(BY_TITLE);

    await page.reload();

    await expect(page.getByTestId("collections-index-card-beta")).toBeVisible();
    expect(await renderedSlugs(page)).toEqual(BY_TITLE);
    await expect(page.getByTestId("collections-sort-title")).toHaveAttribute("aria-pressed", "true");
  });

  test("switching back to slug restores the server order", async ({ page }) => {
    await page.goto("/collections");
    await page.getByTestId("collections-sort-title").click();
    await expect.poll(() => renderedSlugs(page)).toEqual(BY_TITLE);

    await page.getByTestId("collections-sort-slug").click();

    await expect.poll(() => renderedSlugs(page)).toEqual(SERVER_ORDER);
    await expect(page.getByTestId("collections-sort-slug")).toHaveAttribute("aria-pressed", "true");
  });

  test("hides the toggle when a FILTER leaves a single card, and brings it back", async ({ page }) => {
    // The single-collection case below would also pass an implementation that
    // counted the unfiltered list (CodeRabbit on #2896). This one only passes
    // when the count follows what is actually on screen. The read-only entry is
    // what makes the facet chips render at all.
    await mockCollections(page, {
      collections: [...COLLECTIONS_LIST.collections, { slug: "delta", title: "Data", icon: "database", source: "user", readonly: true }],
    });
    await page.goto("/collections");
    await expect(page.getByTestId("collections-sort")).toBeVisible();

    await page.getByTestId("collections-filter-data").click();

    await expect(page.getByTestId("collections-index-card-delta")).toBeVisible();
    await expect(page.getByTestId("collections-index-card-beta")).toBeHidden();
    await expect(page.getByTestId("collections-sort")).toBeHidden();

    await page.getByTestId("collections-filter-all").click();

    await expect(page.getByTestId("collections-sort")).toBeVisible();
  });

  test("hides the toggle when a single collection leaves nothing to order", async ({ page }) => {
    await mockCollections(page, { collections: [COLLECTIONS_LIST.collections[0]] });
    await page.goto("/collections");

    await expect(page.getByTestId("collections-index-card-beta")).toBeVisible();
    await expect(page.getByTestId("collections-sort")).toBeHidden();
  });
});
