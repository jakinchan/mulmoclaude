// E2E for the presentDocument source editor's bookmark rail.
//
// The user-visible contract: while the markdown source editor is open, every
// place matching the configured bookmark regex gets a clickable triangle in a
// rail down the editor's left edge, positioned at that place's position in the
// whole document; clicking one scrolls the editor there. The pattern comes from
// the host-neutral `~/.config/mulmo/config.json` over the plugin's
// `bookmarkPattern` dispatch, with `^\.\.\.` as the shipped default.
//
// Mounted the way the canvas mounts it: a `presentDocument` tool_result in a
// session's entries, with the plugin's dispatch route mocked (there is no
// backend in the mock e2e suite).

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { API_ROUTES } from "../../src/config/apiRoutes";
import { ONE_SECOND_MS } from "../../server/utils/time.ts";

const SESSION_ID = "markdown-bookmarks-session";
const DOC_PATH = "artifacts/documents/2026/08/bookmarked.md";

// Three bookmarks spread through a document long enough for the editor to
// scroll: the rail's positions only mean something against real distance.
const FILLER = Array.from({ length: 40 }, (_unused, index) => `line ${index} of filler text`).join("\n");
const DOC_CONTENT = ["# Bookmarked document", "", "...first mark", FILLER, "...second mark", FILLER, "...third mark", FILLER, ""].join("\n");

interface SetupOpts {
  /** What the host reports for `bookmarkPattern`. `undefined` = not configured
   *  (the View falls back to its default); `"fail"` = a host that does not know
   *  the dispatch kind at all. */
  pattern?: string | "fail" | undefined;
}

async function setup(page: Page, opts: SetupOpts = {}): Promise<void> {
  await mockAllApis(page, {
    sessions: [
      {
        id: SESSION_ID,
        title: "Bookmarked document",
        roleId: "general",
        startedAt: "2026-08-05T10:00:00Z",
        updatedAt: "2026-08-05T10:05:00Z",
      },
    ],
  });

  await page.route(
    (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
    (route) =>
      route.fulfill({
        json: [
          { type: "session_meta", roleId: "general", sessionId: SESSION_ID },
          { type: "text", source: "user", message: "Show me the document" },
          {
            type: "tool_result",
            source: "tool",
            result: {
              uuid: "markdown-result-1",
              toolName: "presentDocument",
              message: "Presented existing document",
              data: { markdown: DOC_PATH, docPath: DOC_PATH },
            },
          },
        ],
      }),
  );

  await page.route(
    (url) => url.pathname === API_ROUTES.plugins.runtimeDispatch.replace(":pkg", "markdown"),
    async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as { kind?: string };
      if (body.kind === "loadDoc") return route.fulfill({ json: { content: DOC_CONTENT } });
      if (body.kind === "bookmarkPattern") {
        if (opts.pattern === "fail") return route.fulfill({ status: 400, json: { error: "unrecognised dispatch payload" } });
        return route.fulfill({ json: { pattern: opts.pattern ?? null } });
      }
      return route.fulfill({ json: {} });
    },
  );
}

/** Open the session and the markdown source editor inside it. */
async function openEditor(page: Page): Promise<void> {
  await page.goto(`/?session=${SESSION_ID}`);
  await expect(page.getByText("Bookmarked document").first()).toBeVisible({ timeout: 10 * ONE_SECOND_MS });
  await page.getByRole("button", { name: "Edit Markdown Source" }).click();
  await expect(page.locator("textarea.markdown-editor")).toBeVisible();
}

const markers = (page: Page) => page.locator(".bookmark-marker");

test.describe("presentDocument — source-editor bookmark rail", () => {
  test("marks every default `...` bookmark, ordered down the rail", async ({ page }) => {
    await setup(page);
    await openEditor(page);

    await expect(markers(page)).toHaveCount(3);
    await expect(markers(page).first()).toHaveAttribute("title", "...first mark");
    await expect(markers(page).nth(1)).toHaveAttribute("title", "...second mark");
    await expect(markers(page).nth(2)).toHaveAttribute("title", "...third mark");

    // Each marker sits lower than the one before it — the rail's whole point is
    // that a bookmark's height IS its position in the document.
    const tops = await markers(page).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
    expect(tops).toHaveLength(3);
    expect(tops[1] ?? 0).toBeGreaterThan(tops[0] ?? 0);
    expect(tops[2] ?? 0).toBeGreaterThan(tops[1] ?? 0);
  });

  test("clicking a marker scrolls the editor to it", async ({ page }) => {
    await setup(page);
    await openEditor(page);

    const editor = page.locator("textarea.markdown-editor");
    expect(await editor.evaluate((node: HTMLTextAreaElement) => node.scrollTop)).toBe(0);

    await markers(page).nth(2).click();

    // Scrolled down, and the caret landed on the third mark.
    await expect.poll(async () => editor.evaluate((node: HTMLTextAreaElement) => node.scrollTop), { timeout: 5 * ONE_SECOND_MS }).toBeGreaterThan(0);
    const caret = await editor.evaluate((node: HTMLTextAreaElement) => node.value.slice(node.selectionStart, node.selectionStart + 12));
    expect(caret).toBe("...third mar");
  });

  test("lands ON the bookmarked line, not near it", async ({ page }) => {
    // The regression this guards: positions derived from a character offset as
    // a fraction of the document length overshot the mark — a blank line and a
    // wrapped paragraph carry very different characters per line of height.
    // Measured geometry has to put the marked line at the top of the viewport,
    // within a line height, for every marker.
    await setup(page);
    await openEditor(page);
    await expect(markers(page)).toHaveCount(3);

    for (const [index, expected] of ["...first mark", "...second mark", "...third mark"].entries()) {
      await markers(page).nth(index).click();
      // Let the debounced measurement and the scroll settle.
      await expect
        .poll(
          async () =>
            page.locator("textarea.markdown-editor").evaluate((node: HTMLTextAreaElement) => {
              // Which source line is at the very top of the visible box. Every
              // line in this fixture is short enough not to wrap, so the line
              // at `scrollTop` is `(scrollTop - paddingTop) / lineHeight`.
              const style = window.getComputedStyle(node);
              const lineHeight = parseFloat(style.lineHeight);
              const paddingTop = parseFloat(style.paddingTop);
              return node.value.split("\n")[Math.round((node.scrollTop - paddingTop) / lineHeight)] ?? "";
            }),
          { timeout: 5 * ONE_SECOND_MS },
        )
        .toBe(expected);
    }
  });

  test("honours a pattern configured in the shared global config", async ({ page }) => {
    // A different pattern must replace the default outright, not add to it.
    await setup(page, { pattern: "^# " });
    await openEditor(page);

    await expect(markers(page)).toHaveCount(1);
    await expect(markers(page).first()).toHaveAttribute("title", "# Bookmarked document");
  });

  test("falls back to the default when the host cannot answer", async ({ page }) => {
    await setup(page, { pattern: "fail" });
    await openEditor(page);

    await expect(markers(page)).toHaveCount(3);
  });

  test("shows no rail while the editor is closed, or when nothing matches", async ({ page }) => {
    await setup(page, { pattern: "^NOTHING-MATCHES-THIS" });

    await page.goto(`/?session=${SESSION_ID}`);
    await expect(page.getByRole("button", { name: "Edit Markdown Source" })).toBeVisible({ timeout: 10 * ONE_SECOND_MS });
    await expect(page.locator(".bookmark-rail")).toHaveCount(0);

    await page.getByRole("button", { name: "Edit Markdown Source" }).click();
    await expect(page.locator("textarea.markdown-editor")).toBeVisible();
    await expect(page.locator(".bookmark-rail")).toHaveCount(0);
  });
});
