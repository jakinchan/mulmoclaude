// E2E for per-session chat input drafts (#2811).
//
// The draft lives in sessionStorage keyed by session id: a reload
// restores what the user was typing, a session switch shows that
// session's own draft, and anything that leaves the input empty (a
// send) must leave nothing behind for the next load to resurrect.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { SESSION_A, SESSION_B } from "../fixtures/sessions";
import { chatInput, fillChatInput, clickSend, selectSessionTab, startNewSession } from "../fixtures/chat";

const DRAFT_A = "draft for session A";
const DRAFT_B = "draft for session B";
const DRAFTS_STORAGE_KEY = "chat_drafts_by_session";

async function storedDrafts(page: Page): Promise<string> {
  return (await page.evaluate((key) => sessionStorage.getItem(key), DRAFTS_STORAGE_KEY)) ?? "";
}

// Which session an /api/agent POST addressed, or null when the body
// isn't the shape we expect (so a malformed body fails the assertion
// rather than throwing).
function sentChatSessionId(body: string | undefined): string | null {
  if (!body) return null;
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || !("chatSessionId" in parsed)) return null;
  return typeof parsed.chatSessionId === "string" ? parsed.chatSessionId : null;
}

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

  // Switching away from a never-sent-to session evicts it: it has no
  // route and no history row left, so its draft must not sit in storage
  // forever — nothing can ever bring it back on screen.
  test("an evicted empty session leaves no orphan draft behind", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    await startNewSession(page);
    const [, emptySessionId] = new URL(page.url()).pathname.split("/chat/");
    await fillChatInput(page, "written in a chat that never happened");
    expect(await storedDrafts(page)).toContain(emptySessionId);

    await selectSessionTab(page, SESSION_A.id);

    expect(await storedDrafts(page)).not.toContain(emptySessionId);
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

  // Attachment upload is a real round trip, so the displayed session can
  // change before it resolves. The turn belongs to the session the user
  // composed it in — both when the upload fails (the draft goes back
  // there) and when it succeeds (the message is sent there).
  test("a send whose upload outlives a session switch still lands in the origin session", async ({ page }) => {
    let releaseUpload = (): void => undefined;
    const uploadHeld = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const agentBodies: string[] = [];

    await page.route(
      (url) => url.pathname === "/api/attachments",
      async (route) => {
        await uploadHeld;
        await route.fulfill({ json: { path: "/w/data/attachments/a.png", originalPath: "a.png", mimeType: "image/png" } });
      },
    );
    await page.route(
      (url) => url.pathname === "/api/agent",
      (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        agentBodies.push(route.request().postData() ?? "");
        return route.fulfill({ status: 202, json: { chatSessionId: "mock-session" } });
      },
    );

    await page.goto(`/chat/${SESSION_A.id}`);
    await page.getByTestId("file-input").setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: Buffer.from("a") }]);
    await fillChatInput(page, DRAFT_A);
    await clickSend(page);

    await selectSessionTab(page, SESSION_B.id);
    releaseUpload();

    await expect.poll(() => agentBodies.length).toBe(1);
    expect(sentChatSessionId(agentBodies[0])).toBe(SESSION_A.id);
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
