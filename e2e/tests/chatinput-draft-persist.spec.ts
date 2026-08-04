// E2E for per-session chat input drafts (#2811).
//
// The draft lives in sessionStorage keyed by session id: a reload
// restores what the user was typing, a session switch shows that
// session's own draft, and anything that leaves the input empty (a
// send) must leave nothing behind for the next load to resurrect.

import { test, expect } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { SESSION_A, SESSION_B } from "../fixtures/sessions";
import { chatInput, fillChatInput, clickSend, selectSessionTab, startNewSession } from "../fixtures/chat";

const DRAFT_A = "draft for session A";
const DRAFT_B = "draft for session B";

test.beforeEach(async ({ page }) => {
  await mockAllApis(page);
});

test.describe("chat input draft persistence", () => {
  test("restores the draft after a reload", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    await fillChatInput(page, DRAFT_A);

    await page.reload();

    await expect(chatInput(page)).toHaveValue(DRAFT_A);
  });

  test("keeps each session's draft to itself", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    await fillChatInput(page, DRAFT_A);

    await page.goto(`/chat/${SESSION_B.id}`);
    await expect(chatInput(page)).toHaveValue("");
    await fillChatInput(page, DRAFT_B);

    await page.goto(`/chat/${SESSION_A.id}`);
    await expect(chatInput(page)).toHaveValue(DRAFT_A);

    await page.goto(`/chat/${SESSION_B.id}`);
    await expect(chatInput(page)).toHaveValue(DRAFT_B);
  });

  test("switching sessions in-app swaps the draft instead of carrying it over", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    await fillChatInput(page, DRAFT_A);

    await selectSessionTab(page, SESSION_B.id);
    await expect(chatInput(page)).toHaveValue("");

    await selectSessionTab(page, SESSION_A.id);
    await expect(chatInput(page)).toHaveValue(DRAFT_A);
  });

  test("a new session starts with an empty input", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    await fillChatInput(page, DRAFT_A);

    await startNewSession(page);

    await expect(chatInput(page)).toHaveValue("");
  });

  test("attachments stay with their own session", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    await page.getByTestId("file-input").setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: Buffer.from("a") }]);
    await expect(page.getByTestId("chat-attachment-list")).toHaveCount(1);

    await selectSessionTab(page, SESSION_B.id);
    await expect(page.getByTestId("chat-attachment-list")).toHaveCount(0);

    await selectSessionTab(page, SESSION_A.id);
    await expect(page.getByTestId("chat-attachment-list")).toHaveCount(1);
  });

  test("a sent message does not come back on the next load", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    await fillChatInput(page, DRAFT_A);
    await clickSend(page);
    await expect(chatInput(page)).toHaveValue("");

    await page.reload();

    await expect(chatInput(page)).toHaveValue("");
  });

  test("clearing the input by hand leaves nothing stored", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    await fillChatInput(page, DRAFT_A);
    await fillChatInput(page, "");

    await page.reload();

    await expect(chatInput(page)).toHaveValue("");
  });
});
