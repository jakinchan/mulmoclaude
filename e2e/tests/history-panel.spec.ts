// E2E for the session-history side panel. Covers:
// - toggle opens / closes the panel
// - opening the panel triggers a fresh /api/sessions fetch
// - clicking a session row navigates to /chat/:id
// - filter pill bar: active-class for current pill, per-origin filter
//   behavior, reset on close-then-reopen
//
// Scope-matching note: the panel used to live at /history. That route
// is gone — the filter bar is now panel-local state, and tests that
// asserted URL shape have been retired in favor of DOM assertions.

import { test, expect, type Route } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { SESSION_A, SESSION_B, makeSessionEntries } from "../fixtures/sessions";

function urlEndsWith(suffix: string): (url: URL) => boolean {
  return (url) => url.pathname === suffix;
}

test.describe("session-history side panel", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("toggling the button opens the panel with server sessions", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByText("MulmoClaude")).toBeVisible();

    // Panel is closed initially — session items should not be in DOM.
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeHidden();

    await page.getByTestId("session-history-toggle-off").click();

    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_B.id}`)).toBeVisible();
  });

  test("clicking a session navigates to /chat/:id and closes nothing", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByText("MulmoClaude")).toBeVisible();

    await page.getByTestId("session-history-toggle-off").click();
    await page.getByTestId(`session-item-${SESSION_A.id}`).click();

    await expect(page).toHaveURL(new RegExp(`/chat/${SESSION_A.id}`));
  });

  test("toggle click triggers a fresh /api/sessions fetch", async ({ page }) => {
    // Count /api/sessions GETs so we can verify opening the panel
    // fires a lazy fetch on top of the initial onMount one.
    let sessionFetchCount = 0;
    await page.route(urlEndsWith("/api/sessions"), (route: Route) => {
      if (route.request().method() === "GET") {
        sessionFetchCount++;
      }
      return route.fulfill({
        json: {
          sessions: [SESSION_A, SESSION_B],
          cursor: "v1:0",
          deletedIds: [],
        },
      });
    });

    await page.goto("/chat");
    await expect(page.getByText("MulmoClaude")).toBeVisible();
    // Wait for the onMount /api/sessions GET to land before snapshotting the baseline.
    await expect.poll(() => sessionFetchCount).toBeGreaterThan(0);
    const countAfterMount = sessionFetchCount;

    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();

    // One additional fetch should have happened on panel open.
    expect(sessionFetchCount).toBeGreaterThan(countAfterMount);
  });

  test("filter bar is visible with All/Unread/Human/Scheduler/Skill/Bridge buttons", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByText("MulmoClaude")).toBeVisible();

    await page.getByTestId("session-history-toggle-off").click();

    const filterBar = page.getByTestId("session-filter-bar");
    await expect(filterBar).toBeVisible();

    await expect(page.getByTestId("session-filter-all")).toBeVisible();
    await expect(page.getByTestId("session-filter-unread")).toBeVisible();
    await expect(page.getByTestId("session-filter-human")).toBeVisible();
    await expect(page.getByTestId("session-filter-scheduler")).toBeVisible();
    await expect(page.getByTestId("session-filter-skill")).toBeVisible();
    await expect(page.getByTestId("session-filter-bridge")).toBeVisible();
  });
});

test.describe("session selection feedback", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("the clicked row highlights before its transcript arrives", async ({ page }) => {
    // Regression guard for #2809: loadSession used to write
    // currentSessionId only after `GET /api/sessions/:id` resolved, so
    // the selection border waited on the round trip. Hold the response
    // open and assert the border is already there.
    let releaseTranscript = (): void => {};
    const transcriptGate = new Promise<void>((resolve) => {
      releaseTranscript = resolve;
    });

    // Registered after mockAllApis, so Playwright checks it first.
    await page.route(
      (url) => url.pathname === `/api/sessions/${SESSION_A.id}`,
      async (route: Route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await transcriptGate;
        return route.fulfill({ json: makeSessionEntries(SESSION_A.id) });
      },
    );

    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    const row = page.getByTestId(`session-item-${SESSION_A.id}`);
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/border-blue-500/);

    await row.click();

    // Still gated — nothing has come back from the server yet.
    await expect(row).toHaveClass(/border-blue-500/);

    releaseTranscript();
    await expect(page).toHaveURL(new RegExp(`/chat/${SESSION_A.id}`));
  });
});

test.describe("session-history filter pills", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("All is active when the panel first opens", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();

    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    // Class derived in the component: active pill gets bg-blue-600.
    await expect(page.getByTestId("session-filter-all")).toHaveClass(/bg-blue-600/);
  });

  test("clicking Unread highlights the pill", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();

    await page.getByTestId("session-filter-unread").click();

    await expect(page.getByTestId("session-filter-unread")).toHaveClass(/bg-blue-600/);
    await expect(page.getByTestId("session-filter-all")).not.toHaveClass(/bg-blue-600/);
  });

  test("Human pill keeps default-origin sessions visible", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();

    await page.getByTestId("session-filter-human").click();

    await expect(page.getByTestId("session-filter-human")).toHaveClass(/bg-blue-600/);
    // Default-origin sessions (no `origin` field) render as `human`
    // per `originOf`, so they remain visible under the Human filter.
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
  });

  test("switching filters updates the visible session set", async ({ page }) => {
    // Cover bridge → scheduler → all transitions, not just one pill.
    // Subsumes the older single-Bridge case from the panel describe.
    await page.route(urlEndsWith("/api/sessions"), (route: Route) =>
      route.fulfill({
        json: {
          sessions: [
            { ...SESSION_A, origin: "bridge" },
            { ...SESSION_B, origin: "scheduler" },
          ],
          cursor: "v1:0",
          deletedIds: [],
        },
      }),
    );

    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_B.id}`)).toBeVisible();

    await page.getByTestId("session-filter-bridge").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_B.id}`)).toBeHidden();

    await page.getByTestId("session-filter-scheduler").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeHidden();
    await expect(page.getByTestId(`session-item-${SESSION_B.id}`)).toBeVisible();

    await page.getByTestId("session-filter-all").click();
    await expect(page.getByTestId(`session-item-${SESSION_A.id}`)).toBeVisible();
    await expect(page.getByTestId(`session-item-${SESSION_B.id}`)).toBeVisible();
  });

  test("closing and reopening the panel resets the filter to All", async ({ page }) => {
    // Panel-local filter state on purpose: reopening should land you
    // on the familiar "everything" view rather than remembering the
    // last narrow filter, which can be surprising after a break.
    await page.goto("/chat");
    await page.getByTestId("session-history-toggle-off").click();
    await page.getByTestId("session-filter-unread").click();
    await expect(page.getByTestId("session-filter-unread")).toHaveClass(/bg-blue-600/);

    // Close (dock toggle in panel header).
    await page.getByTestId("session-history-toggle-on").click();
    await expect(page.getByTestId("session-history-side-panel")).toBeHidden();

    // Reopen.
    await page.getByTestId("session-history-toggle-off").click();
    await expect(page.getByTestId("session-filter-all")).toHaveClass(/bg-blue-600/);
  });
});
