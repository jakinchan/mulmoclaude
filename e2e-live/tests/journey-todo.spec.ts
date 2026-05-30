import { randomUUID } from "node:crypto";

import { type Locator, type Page, type Response, expect, test } from "@playwright/test";

import { ONE_MINUTE_MS, ONE_SECOND_MS } from "../../server/utils/time.ts";

// Per-test wall-time budget — no LLM call, so the only latency is
// SPA boot + a couple of `/api/todos` round trips. Keeping the
// ceiling roomy lets the spec ride through CI cold-start jitter.
const JOURNEY_TIMEOUT_MS = 2 * ONE_MINUTE_MS;

// Cap on how long we wait for a todo-plugin runtime dispatch (create
// / patch / delete) to flush to disk. 10s gives slow CI workers
// headroom without hiding a real stall — anything past this is a
// real bug, not a CI quirk.
const DISPATCH_FLUSH_TIMEOUT_MS = 10 * ONE_SECOND_MS;

// `useTodos` (packages/plugins/todo-plugin/src/composables/useTodos.ts)
// routes every mutation through `runtime.dispatch`, which the host
// exposes as POST /api/plugins/runtime/<pkg>/dispatch. Anchor the
// gate on this substring so we ignore unrelated SSE / metrics traffic
// the SPA fires in the background.
const TODO_DISPATCH_URL_FRAGMENT = "/api/plugins/runtime/";
const TODO_PLUGIN_SLUG_FRAGMENT = "todo-plugin";

// L-JOURNEY-TODO net (plans/feat-e2e-live.md §「未確定事項 / TODO」
// L-JOURNEY-*). The existing L-DISPATCH-TODO covers the LLM →
// `manageTodoList` dispatch path only; this spec covers the human
// path — user opens `/todos`, fills the Add dialog, ticks the
// completed checkbox, reloads, and the todo (and its checked state)
// is still there. No LLM call, no `setupRoleSession`, no chat
// turn — the regressions this catches are pure SPA + REST + file
// write/read (TodoExplorer.vue ↔ `/api/todos` ↔ data/todos/todos.json
// ↔ post-reload hydration).
test.describe("L-JOURNEY-TODO — UI からの正常系 add + check + reload", () => {
  test.describe.configure({ timeout: JOURNEY_TIMEOUT_MS });

  test("UI から todo を add → check → reload で残る", async ({ page }) => {
    const marker = `L-JOURNEY-TODO-${Date.now()}-${randomUUID().slice(0, 6)}`;

    try {
      await openTodosView(page);
      await addTodoWithMarker(page, marker);

      const card = scopeCardByMarker(page, marker);
      await expect(card, "newly added todo must be visible in kanban").toBeVisible();

      const checkbox = card.locator('input[type="checkbox"]').first();
      await expect(checkbox, "new todo starts un-completed").not.toBeChecked();
      await togglePersistedThroughDispatch(page, checkbox);
      await expect(checkbox, "checkbox state flips immediately").toBeChecked();

      await page.reload();
      await expect(page.getByTestId("todo-view-root")).toBeVisible();

      const cardAfter = scopeCardByMarker(page, marker);
      await expect(cardAfter, "todo persists across reload").toBeVisible();
      await expect(cardAfter.locator('input[type="checkbox"]').first(), "completed state persists across reload").toBeChecked();
    } finally {
      await deleteTodoByMarker(page, marker);
    }
  });
});

async function openTodosView(page: Page): Promise<void> {
  await page.goto("/todos");
  await expect(page.getByTestId("todo-view-root"), "/todos route must mount TodoExplorer").toBeVisible();
}

async function addTodoWithMarker(page: Page, marker: string): Promise<void> {
  await page.getByTestId("todo-add-btn").click();
  const textInput = page.getByTestId("todo-add-dialog-text");
  await expect(textInput, "add dialog must be open and focused").toBeVisible();
  await textInput.fill(marker);
  const flushed = waitForTodoDispatch(page);
  await page.getByTestId("todo-add-dialog-submit").click();
  await flushed;
  await expect(textInput, "add dialog must close on submit").toHaveCount(0);
}

// Toggle the checkbox AND wait for the runtime dispatch to flush
// before returning. Without this gate the immediate `page.reload()`
// in the spec body can outrun the in-flight POST — the server then
// hydrates from a pre-toggle disk state and the assertion fails
// flakily. Codex iter-1 must-fix.
async function togglePersistedThroughDispatch(page: Page, checkbox: Locator): Promise<void> {
  const flushed = waitForTodoDispatch(page);
  await checkbox.check();
  await flushed;
}

function waitForTodoDispatch(page: Page): Promise<Response> {
  return page.waitForResponse(
    (resp) =>
      resp.url().includes(TODO_DISPATCH_URL_FRAGMENT) && resp.url().includes(TODO_PLUGIN_SLUG_FRAGMENT) && resp.request().method() === "POST" && resp.ok(),
    { timeout: DISPATCH_FLUSH_TIMEOUT_MS },
  );
}

function scopeCardByMarker(page: Page, marker: string): Locator {
  return page.locator('[data-testid^="todo-card-"]').filter({ hasText: marker }).first();
}

async function deleteTodoByMarker(page: Page, marker: string): Promise<void> {
  try {
    if (page.isClosed()) return;
    const card = scopeCardByMarker(page, marker);
    if ((await card.count()) === 0) return;
    await triggerDeleteWithConfirmAccept(page, card);
    // Gate cleanup completion on the SPA dropping the card row, which
    // only flips after applyResult() rehydrates items[] from the
    // delete dispatch response. Without this wait parallel workers
    // can race against this marker still being on disk when they
    // list todos, surfacing as stray rows in unrelated specs
    // (Codex iter-1 nit).
    await expect(card, "deleted todo must vanish from the kanban").toHaveCount(0, { timeout: DISPATCH_FLUSH_TIMEOUT_MS });
  } catch (err) {
    console.warn(`deleteTodoByMarker: best-effort cleanup skipped for marker ${marker}`, err);
  }
}

async function triggerDeleteWithConfirmAccept(page: Page, card: Locator): Promise<void> {
  page.once("dialog", (dialog) => {
    dialog.accept().catch(() => undefined);
  });
  const flushed = waitForTodoDispatch(page);
  await card.click();
  await page.getByTestId("todo-edit-dialog-delete").click();
  await flushed;
}
