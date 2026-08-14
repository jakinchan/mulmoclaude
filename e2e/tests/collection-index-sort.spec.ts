// E2E for the collections-index display order (#2836): the Slug / Name toggle
// reorders the cards, the choice survives a reload (localStorage), and the
// control stays out of the way when there is nothing to order.
//
// The slugs and titles below deliberately disagree, so each assertion pins a
// real reordering rather than one order that happens to match both keys.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const COLLECTIONS_LIST = {
  collections: [
    { slug: "alpha", title: "Zebra", icon: "bookmark", source: "user" },
    { slug: "beta", title: "Mango", icon: "bookmark", source: "user" },
    { slug: "gamma", title: "Apple", icon: "bookmark", source: "user" },
  ],
};

const BY_SLUG = ["alpha", "beta", "gamma"];
const BY_TITLE = ["gamma", "beta", "alpha"];

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

  test("defaults to slug order and switches to name order on click", async ({ page }) => {
    await page.goto("/collections");
    await expect(page.getByTestId("collections-index-card-alpha")).toBeVisible();

    // Default matches the server's discovery order, so nothing moves for a user
    // who never touches the toggle.
    expect(await renderedSlugs(page)).toEqual(BY_SLUG);
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

    await expect(page.getByTestId("collections-index-card-alpha")).toBeVisible();
    expect(await renderedSlugs(page)).toEqual(BY_TITLE);
    await expect(page.getByTestId("collections-sort-title")).toHaveAttribute("aria-pressed", "true");
  });

  test("switching back to slug restores the discovery order", async ({ page }) => {
    await page.goto("/collections");
    await page.getByTestId("collections-sort-title").click();
    await expect.poll(() => renderedSlugs(page)).toEqual(BY_TITLE);

    await page.getByTestId("collections-sort-slug").click();

    await expect.poll(() => renderedSlugs(page)).toEqual(BY_SLUG);
    await expect(page.getByTestId("collections-sort-slug")).toHaveAttribute("aria-pressed", "true");
  });

  test("hides the toggle when a single collection leaves nothing to order", async ({ page }) => {
    await mockCollections(page, { collections: [COLLECTIONS_LIST.collections[0]] });
    await page.goto("/collections");

    await expect(page.getByTestId("collections-index-card-alpha")).toBeVisible();
    await expect(page.getByTestId("collections-sort")).toBeHidden();
  });
});
