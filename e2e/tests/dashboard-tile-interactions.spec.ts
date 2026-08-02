import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

// The dashboard's three pointer/select handlers had no e2e coverage at all,
// so a broken narrowing in any of them type-checked and shipped silently:
// the tile would simply stop dragging, resizing, or switching view. These
// drive the real handlers and assert the persisted layout that results.

const TILE_SLUGS = ["tasks", "notes"] as const;

const collectionDetail = (slug: string, title: string) => ({
  collection: {
    slug,
    title,
    icon: "checklist",
    source: "user",
    schema: {
      title,
      icon: "checklist",
      dataPath: `data/${slug}/items`,
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true },
        title: { type: "string", label: "Title", required: true },
        status: { type: "enum", label: "Status", values: ["todo", "done"] },
      },
    },
  },
  items: [{ id: "a", title: `${title} item`, status: "todo" }],
});

/** Layout PUTs the component makes, newest last. */
interface SavedLayout {
  tiles: { slug: string; viewMode?: string }[];
  rowHeights?: Record<string, number[]> | undefined;
}

async function setup(page: Page): Promise<SavedLayout[]> {
  const saved: SavedLayout[] = [];
  await mockAllApis(page);

  for (const slug of TILE_SLUGS) {
    await page.route(
      (url) => url.pathname === `/api/collections/${slug}`,
      (route) => route.fulfill({ json: collectionDetail(slug, slug === "tasks" ? "Tasks" : "Notes") }),
    );
  }

  // Membership derives from pinned collection shortcuts.
  await page.route(
    (url) => url.pathname === "/api/shortcuts",
    (route) =>
      route.fulfill({
        json: { shortcuts: TILE_SLUGS.map((slug) => ({ kind: "collection", slug, title: slug === "tasks" ? "Tasks" : "Notes", icon: "checklist" })) },
      }),
  );

  // Stateful: the component replaces the layout wholesale, and later reads
  // must see what the earlier write stored.
  const state: SavedLayout = { tiles: TILE_SLUGS.map((slug) => ({ slug })), rowHeights: {} };
  await page.route(
    (url) => url.pathname === "/api/dashboard",
    (route) => {
      if (route.request().method() === "PUT") {
        const body: SavedLayout = JSON.parse(route.request().postData() ?? "{}");
        state.tiles = body.tiles ?? state.tiles;
        state.rowHeights = body.rowHeights ?? state.rowHeights;
        saved.push(JSON.parse(JSON.stringify(state)));
        return route.fulfill({ json: state });
      }
      return route.fulfill({ json: state });
    },
  );

  await page.goto("/dashboard");
  await expect(page.getByTestId("dashboard-grid")).toBeVisible();
  return saved;
}

test.describe("DashboardView — tile interactions", () => {
  test("the view picker persists the chosen mode for that tile", async ({ page }) => {
    const saved = await setup(page);
    const picker = page.getByTestId("dashboard-tile-view-tasks");
    await expect(picker).toBeVisible();

    // `onPickView` reads `event.target`; if that narrowing fails the handler
    // returns early and nothing is ever persisted.
    await picker.selectOption("kanban");
    await expect.poll(() => saved.at(-1)?.tiles.find((tile) => tile.slug === "tasks")?.viewMode).toBe("kanban");
  });

  test("dragging the handle reorders the tiles", async ({ page }) => {
    const saved = await setup(page);
    const handles = page.getByTestId("dashboard-tile-drag");
    await expect(handles).toHaveCount(TILE_SLUGS.length);

    const source = await handles.nth(0).boundingBox();
    const destination = await handles.nth(1).boundingBox();
    expect(source).not.toBeNull();
    expect(destination).not.toBeNull();
    if (!source || !destination) return;

    // `onReorderStart` captures the pointer to `event.currentTarget`; a failed
    // narrowing means no drag ever starts.
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => saved.at(-1)?.tiles.map((tile) => tile.slug)).toEqual(["notes", "tasks"]);
  });

  test("dragging the resize handle stores a row height", async ({ page }) => {
    const saved = await setup(page);
    const handle = page.getByTestId("dashboard-tile-resize-tasks");
    await expect(handle).toBeVisible();

    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // `onResizeStart` captures the pointer the same way.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 12 });
    await page.mouse.up();

    await expect
      .poll(() =>
        Object.values(saved.at(-1)?.rowHeights ?? {})
          .flat()
          .some((height) => height > 0),
      )
      .toBe(true);
  });
});
