// E2E coverage for the bell after the notifier-engine migration
// (PR 4 of feat-encore).
//
// Each scenario primes the bell via the new `/api/notifier` endpoint
// (`action: "list"` returns a single canned entry whose `pluginData`
// carries the legacy `NotificationKind` + `i18n` shape, exactly the
// payload the wrapper produces server-side). The bell is expected to:
//
//   - render a row with the right testid;
//   - on body click for fyi rows, navigate to `entry.navigateTarget`
//     AND remove the entry (legacy entries publish with
//     `lifecycle: "fyi"`, so the bell calls `clear()` after the
//     navigation);
//   - on `×` click for action rows, remove the entry without
//     navigating (the × is fyi-less by design — fyi rows clear on
//     body click, the debug popup's two-tier UX).
//
// The previous spec asserted on a `data-unread` attribute and a
// "Mark all read" affordance — both removed in PR 4. The new bell
// has no read/unread distinction (entries are either active or in
// history), so those assertions are dropped.
//
// The bell appends `?notificationId=<id>` to every navigation so
// `action`-lifecycle landing pages can identify which entry to
// clear. The URL assertion strips that query param before comparing
// — its presence is an implementation detail of the bell, not a
// scenario guarantee.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { ONE_SECOND_MS } from "../../server/utils/time.ts";

interface NotifierEntryFixture {
  id: string;
  pluginPkg: string;
  severity: "info" | "nudge" | "urgent";
  lifecycle: "fyi" | "action";
  title: string;
  body?: string;
  navigateTarget?: string;
  pluginData: {
    legacy: true;
    legacyId: string;
    kind: "todo" | "scheduler" | "agent" | "journal" | "push" | "bridge" | "system";
    priority: "normal" | "high";
    action: { type: "none" } | { type: "navigate"; target: Record<string, unknown> };
  };
  createdAt: string;
}

interface Scenario {
  description: string;
  entry: NotifierEntryFixture;
  expectedUrl: string;
}

function buildEntry(entryId: string, title: string, navigateTarget: string): NotifierEntryFixture {
  return {
    id: entryId,
    pluginPkg: "host",
    severity: "nudge",
    lifecycle: "fyi",
    title,
    body: "E2E fixture body",
    navigateTarget,
    pluginData: {
      legacy: true,
      legacyId: entryId,
      kind: "push",
      priority: "normal",
      action: { type: "navigate", target: { view: "automations" } },
    },
    createdAt: "2026-04-25T06:00:00.000Z",
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    description: "chat target with session",
    entry: buildEntry("notif-chat-1", "Agent reply ready", "/chat/sess-xyz"),
    expectedUrl: "/chat/sess-xyz",
  },
  {
    description: "automations target with taskId",
    entry: buildEntry("notif-auto-1", "Scheduled task fired", "/automations/finance-daily-briefing"),
    expectedUrl: "/automations/finance-daily-briefing",
  },
  {
    description: "files target with nested path",
    entry: buildEntry("notif-file-1", "New article ingested", "/files/sources/federal-reserve/2026-04-25.md"),
    expectedUrl: "/files/sources/federal-reserve/2026-04-25.md",
  },
  {
    description: "wiki target with slug + anchor",
    entry: buildEntry("notif-wiki-1", "Briefing published", "/wiki/pages/daily-finance-briefing-2026-04-24#front-page"),
    expectedUrl: "/wiki/pages/daily-finance-briefing-2026-04-24#front-page",
  },
];

/** Override the default `/api/notifier` mock so the bell primes with a
 *  specific list of entries instead of the empty default. Must run
 *  AFTER `mockAllApis` because Playwright matches in reverse-
 *  registration order. */
async function primeNotifierList(page: Page, entries: readonly NotifierEntryFixture[]): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/notifier",
    (route) => {
      const body = route.request().postData();
      const action = parseAction(body);
      if (action === "listHistory") return route.fulfill({ json: { history: [] } });
      if (action === "clear" || action === "cancel") return route.fulfill({ json: { ok: true } });
      return route.fulfill({ json: { entries } });
    },
  );
}

function parseAction(body: string | null): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { action?: unknown };
    return typeof parsed.action === "string" ? parsed.action : undefined;
  } catch {
    return undefined;
  }
}

/** Reconstruct `pathname + search + hash` minus the bell's
 *  `notificationId` parameter. Lets the navigation scenarios assert
 *  on the user-meaningful URL without coupling to the bell's
 *  implementation detail of identifying which entry triggered the
 *  navigation. */
function stripNotificationId(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("notificationId");
  const search = params.toString();
  return url.pathname + (search ? `?${search}` : "") + url.hash;
}

/** Pull the chat sessionId out of a navigateTarget URL (`/chat/<id>…`)
 *  so the test can pre-populate the session mock and App.vue's
 *  loadSession-then-create-on-miss fallback doesn't race the
 *  toHaveURL assertion. Returns undefined for non-chat targets. */
function extractChatSessionId(navigateTarget: string | undefined): string | undefined {
  if (!navigateTarget) return undefined;
  const [, sessionId] = navigateTarget.match(/^\/chat\/([^/?#]+)/) ?? [];
  return sessionId === undefined ? undefined : decodeURIComponent(sessionId);
}

test.describe("notification bell — navigation", () => {
  for (const scenario of SCENARIOS) {
    test(scenario.description, async ({ page }) => {
      // Pre-populate the session mock for chat-target scenarios so
      // loadSession succeeds and App.vue's auto-create fallback
      // doesn't clobber the URL with a fresh sessionId.
      const targetSessionId = extractChatSessionId(scenario.entry.navigateTarget);
      const sessions = targetSessionId
        ? [
            {
              id: targetSessionId,
              title: "Notification target session",
              roleId: "general",
              startedAt: "2026-04-25T00:00:00Z",
              updatedAt: "2026-04-25T00:00:00Z",
            },
          ]
        : [];
      await mockAllApis(page, { sessions });
      await primeNotifierList(page, [scenario.entry]);

      // /files is a quiet page — no auto-session-create races.
      await page.goto("/files");

      // Badge appears once `apiPost(..., {action: "list"})` resolves
      // and the composable populates entries.
      await expect(page.getByTestId("notification-badge")).toBeVisible({ timeout: 5000 });

      await page.getByTestId("notification-bell").click();
      await expect(page.getByTestId("notification-panel")).toBeVisible();

      await page.getByTestId(`notification-item-${scenario.entry.id}`).click();

      await expect(page).toHaveURL((url) => stripNotificationId(url) === scenario.expectedUrl);
    });
  }
});

test.describe("notification bell — dismiss", () => {
  test("× button on an action row cancels the entry", async ({ page }) => {
    // The × button is a property of action rows only — fyi rows
    // clear on body click and don't render a dismiss button (matches
    // the debug popup's two-tier UX). Build an action entry directly
    // since `buildEntry` defaults to fyi.
    const entry: NotifierEntryFixture = {
      ...buildEntry("notif-dismiss-1", "Will be cancelled", "/automations"),
      lifecycle: "action",
      severity: "nudge",
    };
    await mockAllApis(page, { sessions: [] });
    await primeNotifierList(page, [entry]);

    await page.goto("/files");
    await expect(page.getByTestId("notification-badge")).toBeVisible({ timeout: 5000 });

    await page.getByTestId("notification-bell").click();
    await page.getByTestId(`notification-item-${entry.id}`).getByTestId("notification-dismiss").click();

    // Row is gone (the optimistic local update + the engine's
    // `cancelled` event both remove it). The badge clears too.
    await expect(page.getByTestId(`notification-item-${entry.id}`)).toHaveCount(0);
    await expect(page.getByTestId("notification-badge")).toHaveCount(0);
  });

  test("body click on a fyi row clears the entry", async ({ page }) => {
    // No navigateTarget so the click is a pure clear (no router push
    // racing with the assertion).
    const { navigateTarget: __noTarget, ...entry } = buildEntry("notif-fyi-clear-1", "Will be cleared", "");
    await mockAllApis(page, { sessions: [] });
    await primeNotifierList(page, [entry]);

    await page.goto("/files");
    await expect(page.getByTestId("notification-badge")).toBeVisible({ timeout: 5000 });

    await page.getByTestId("notification-bell").click();
    await page.getByTestId(`notification-item-${entry.id}`).click();

    await expect(page.getByTestId(`notification-item-${entry.id}`)).toHaveCount(0);
    await expect(page.getByTestId("notification-badge")).toHaveCount(0);
  });
});

interface NotifierHistoryFixture extends NotifierEntryFixture {
  terminalType: "cleared" | "cancelled";
  terminalAt: string;
}

// Aligned with buildEntry's `createdAt` of 2026-04-25T06:00 — history
// rows are stamped one hour later. Computing via Date arithmetic
// instead of `0${index}` template concat keeps the helper safe past
// index 9 (HISTORY_CAP is 50, so we need to handle two-digit indices).
const HISTORY_BASE_MS = Date.parse("2026-04-25T07:00:00.000Z");

function buildHistoryEntry(index: number): NotifierHistoryFixture {
  // A cleared fyi row carries no navigate target — the key is absent on the
  // wire, not present-and-undefined.
  const { navigateTarget: __noTarget, ...base } = buildEntry(`notif-hist-${index}`, `History entry ${index}`, "");
  return {
    ...base,
    terminalType: "cleared",
    terminalAt: new Date(HISTORY_BASE_MS + index * ONE_SECOND_MS).toISOString(),
  };
}

async function primeNotifierHistory(page: Page, history: readonly NotifierHistoryFixture[]): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/notifier",
    (route) => {
      const body = route.request().postData();
      const action = parseAction(body);
      if (action === "listHistory") return route.fulfill({ json: { history } });
      if (action === "clear" || action === "cancel") return route.fulfill({ json: { ok: true } });
      return route.fulfill({ json: { entries: [] } });
    },
  );
}

test.describe("notification bell — history more / less toggle", () => {
  const HISTORY_INITIAL_VISIBLE = 5;
  const HISTORY_OVERFLOW_TOTAL = 8;
  // The tail entry is built on its own so assertions can name it
  // directly instead of indexing the generated array.
  const buildOverflowHistory = (): { history: NotifierHistoryFixture[]; tail: NotifierHistoryFixture } => {
    const tail = buildHistoryEntry(HISTORY_OVERFLOW_TOTAL - 1);
    const head = Array.from({ length: HISTORY_OVERFLOW_TOTAL - 1 }, (_, index) => buildHistoryEntry(index));
    return { history: [...head, tail], tail };
  };

  test("hides entries beyond the initial cap behind a toggle", async ({ page }) => {
    const { history } = buildOverflowHistory();
    await mockAllApis(page, { sessions: [] });
    await primeNotifierHistory(page, history);

    await page.goto("/files");
    await page.getByTestId("notification-bell").click();
    await expect(page.getByTestId("notification-panel")).toBeVisible();

    // First 5 entries render; the rest are hidden until expanded.
    for (const entry of history.slice(0, HISTORY_INITIAL_VISIBLE)) {
      await expect(page.getByTestId(`notification-history-${entry.id}`)).toBeVisible();
    }
    for (const entry of history.slice(HISTORY_INITIAL_VISIBLE)) {
      await expect(page.getByTestId(`notification-history-${entry.id}`)).toHaveCount(0);
    }

    const toggle = page.getByTestId("notification-history-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText(/3/);

    await toggle.click();
    for (const entry of history) {
      await expect(page.getByTestId(`notification-history-${entry.id}`)).toBeVisible();
    }
    await expect(toggle).not.toHaveText(/3/);

    await toggle.click();
    for (const entry of history.slice(HISTORY_INITIAL_VISIBLE)) {
      await expect(page.getByTestId(`notification-history-${entry.id}`)).toHaveCount(0);
    }
  });

  test("collapses again after closing and reopening the popup", async ({ page }) => {
    const { history, tail } = buildOverflowHistory();
    await mockAllApis(page, { sessions: [] });
    await primeNotifierHistory(page, history);

    await page.goto("/files");
    await page.getByTestId("notification-bell").click();
    await page.getByTestId("notification-history-toggle").click();
    // Confirm we're expanded before the close-reopen cycle.
    await expect(page.getByTestId(`notification-history-${tail.id}`)).toBeVisible();

    // Click outside the bell to close (App-level outside-click handler).
    await page.mouse.click(10, 10);
    await expect(page.getByTestId("notification-panel")).toHaveCount(0);

    await page.getByTestId("notification-bell").click();
    await expect(page.getByTestId("notification-panel")).toBeVisible();
    // The hidden tail entry should be gone again — state reset on close.
    await expect(page.getByTestId(`notification-history-${tail.id}`)).toHaveCount(0);
    await expect(page.getByTestId("notification-history-toggle")).toBeVisible();
  });

  test("toggle is absent when history is at or under the initial cap", async ({ page }) => {
    const firstEntry = buildHistoryEntry(0);
    const history = [firstEntry, ...Array.from({ length: HISTORY_INITIAL_VISIBLE - 1 }, (_, index) => buildHistoryEntry(index + 1))];
    await mockAllApis(page, { sessions: [] });
    await primeNotifierHistory(page, history);

    await page.goto("/files");
    await page.getByTestId("notification-bell").click();
    await expect(page.getByTestId(`notification-history-${firstEntry.id}`)).toBeVisible();
    await expect(page.getByTestId("notification-history-toggle")).toHaveCount(0);
  });

  // The "boundary +1" case (6 entries → toggle with hidden count 1)
  // used to live here. The 5-entry "toggle absent" case above and the
  // 8-entry expand/collapse case already pin the threshold at exactly
  // 5; the +1 case was over-specification.
});

function buildHistoryEntryWithBody(index: number, body: string, navigateTarget?: string): NotifierHistoryFixture {
  const base = buildHistoryEntry(index);
  return { ...base, body, ...(navigateTarget !== undefined ? { navigateTarget } : {}) };
}

test.describe("notification bell — history body expansion", () => {
  test("clicking a history row with body expands and collapses the body", async ({ page }) => {
    const entry = buildHistoryEntryWithBody(0, "Detailed body text for testing");
    await mockAllApis(page, { sessions: [] });
    await primeNotifierHistory(page, [entry]);

    await page.goto("/todos");
    await page.getByTestId("notification-bell").click();

    const row = page.getByTestId(`notification-history-${entry.id}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId("notification-history-body")).toHaveCount(0);

    await row.click();
    await expect(page.getByTestId("notification-history-body")).toBeVisible();
    await expect(page.getByTestId("notification-history-body")).toHaveText("Detailed body text for testing");

    await row.click();
    await expect(page.getByTestId("notification-history-body")).toHaveCount(0);
  });

  test("expanded body state resets when the panel closes", async ({ page }) => {
    const entry = buildHistoryEntryWithBody(0, "Body resets on close");
    await mockAllApis(page, { sessions: [] });
    await primeNotifierHistory(page, [entry]);

    await page.goto("/todos");
    await page.getByTestId("notification-bell").click();
    await page.getByTestId(`notification-history-${entry.id}`).click();
    await expect(page.getByTestId("notification-history-body")).toBeVisible();

    await page.mouse.click(10, 10);
    await expect(page.getByTestId("notification-panel")).toHaveCount(0);

    await page.getByTestId("notification-bell").click();
    await expect(page.getByTestId("notification-panel")).toBeVisible();
    await expect(page.getByTestId("notification-history-body")).toHaveCount(0);
  });

  test("navigate icon visibility tracks navigateTarget on expanded rows", async ({ page }) => {
    // Two rows side-by-side: one carries `navigateTarget`, the other
    // doesn't. Expanding both proves the icon ONLY surfaces for the
    // row that carries the link — covering presence + absence in one
    // fixture without paying the panel-open overhead twice.
    const linkedEntry = buildHistoryEntryWithBody(0, "Body with link", "/calendar");
    const unlinkedEntry = buildHistoryEntryWithBody(1, "Body without link");
    await mockAllApis(page, { sessions: [] });
    await primeNotifierHistory(page, [linkedEntry, unlinkedEntry]);

    await page.goto("/todos");
    await page.getByTestId("notification-bell").click();

    const withLink = page.getByTestId(`notification-history-${linkedEntry.id}`);
    const withoutLink = page.getByTestId(`notification-history-${unlinkedEntry.id}`);
    // Collapsed: no navigate icon visible anywhere.
    await expect(page.getByTestId("notification-history-navigate")).toHaveCount(0);

    // Expand the linked row → exactly one navigate icon appears.
    await withLink.click();
    await expect(page.getByTestId("notification-history-navigate")).toHaveCount(1);

    // Expand the unlinked row → still exactly one navigate icon (the
    // newly-expanded row contributes none). The body for the unlinked
    // row IS visible, confirming the row expanded.
    await withoutLink.click();
    await expect(page.getByTestId("notification-history-navigate")).toHaveCount(1);
    await expect(page.getByTestId("notification-history-body")).toHaveCount(2);
  });

  test("history row without body or navigateTarget has no expand button", async ({ page }) => {
    const { body: __noBody, ...withoutBody } = buildHistoryEntry(0);
    await mockAllApis(page, { sessions: [] });
    await primeNotifierHistory(page, [withoutBody]);

    await page.goto("/todos");
    await page.getByTestId("notification-bell").click();

    const row = page.getByTestId(`notification-history-${withoutBody.id}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("notification-history-expand")).toHaveCount(0);
  });
});
