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

// Hold the attachment upload open so a test can act while a send is
// mid-flight: `started` resolves when the request arrives, `release`
// lets it complete.
async function holdAttachmentUpload(page: Page): Promise<{ started: Promise<void>; release: () => void }> {
  let release = (): void => undefined;
  let markStarted = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  await page.route(
    (url) => url.pathname === "/api/attachments",
    async (route) => {
      markStarted();
      await held;
      await route.fulfill({ json: { path: "/w/data/attachments/a.png", originalPath: "a.png", mimeType: "image/png" } });
    },
  );
  return { started, release };
}

// Collect the raw body of every /api/agent POST the app dispatches.
async function recordAgentPosts(page: Page): Promise<string[]> {
  const bodies: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/agent",
    (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      bodies.push(route.request().postData() ?? "");
      return route.fulfill({ status: 202, json: { chatSessionId: "mock-session" } });
    },
  );
  return bodies;
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

  // Landing on /chat without a session id in the URL, the composer is
  // usable while the app is still deciding which session to resume. Text
  // typed in that window has no session to belong to yet, and must not
  // disappear when one arrives.
  test("text typed before the session id arrives survives the hand-off", async ({ page }) => {
    let releaseSessions = (): void => undefined;
    const sessionsHeld = new Promise<void>((resolve) => (releaseSessions = resolve));
    await page.route(
      (url) => url.pathname === "/api/sessions",
      async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await sessionsHeld;
        return route.fulfill({ json: { sessions: [], cursor: "v1:0", deletedIds: [] } });
      },
    );

    await page.goto("/");
    await expect(chatInput(page)).toBeVisible();
    await fillChatInput(page, DRAFT_A);
    releaseSessions();

    await expect(page).toHaveURL(/\/chat\/.+/);
    await expect(chatInput(page)).toHaveValue(DRAFT_A);
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
    const upload = await holdAttachmentUpload(page);
    const agentBodies = await recordAgentPosts(page);

    await page.goto(`/chat/${SESSION_A.id}`);
    await page.getByTestId("file-input").setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: Buffer.from("a") }]);
    await fillChatInput(page, DRAFT_A);
    await clickSend(page);

    // Switch only once the upload is provably in flight — otherwise the
    // send could finish before the switch and the race goes untested.
    await upload.started;
    await selectSessionTab(page, SESSION_B.id);
    upload.release();

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
