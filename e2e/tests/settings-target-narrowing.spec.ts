import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

// Two Settings handlers read the element out of `event.target` and had no e2e
// coverage at all, so a wrong narrowing in either type-checks and ships as a
// control that silently stops working: the Maps key would never commit on
// Enter, and the MCP enable checkbox would never persist.

interface McpEntry {
  id: string;
  spec: { type: "http"; url: string; enabled?: boolean };
}

interface ConfigState {
  settings: { extraAllowedTools: string[]; googleMapsApiKey?: string };
  mcp: { servers: McpEntry[] };
}

const GMAIL_SERVER: McpEntry = { id: "gmail", spec: { type: "http", url: "https://gmail.mcp.claude.com/mcp", enabled: true } };

/** Long enough that the tab is observably still loading after it mounts. */
const SLOW_CONFIG_GET_MS = 1000;

/** `/api/config` GET plus the two patch endpoints, reflecting writes back. */
async function mockConfig(page: Page, initial: ConfigState, getDelayMs = 0): Promise<ConfigState> {
  await mockAllApis(page);
  const state: ConfigState = JSON.parse(JSON.stringify(initial));

  await page.route(
    (url) => url.pathname === "/api/config",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      if (getDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, getDelayMs));
      return route.fulfill({ json: state });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/config/settings",
    (route) => {
      const body = route.request().postDataJSON() as { googleMapsApiKey?: string };
      state.settings = { ...state.settings, ...body };
      return route.fulfill({ json: state });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/config/mcp",
    (route) => {
      const body = route.request().postDataJSON() as { servers: McpEntry[] };
      state.mcp = { servers: body.servers };
      return route.fulfill({ json: state });
    },
  );
  return state;
}

async function openTab(page: Page, tabId: string): Promise<void> {
  await page.locator('[data-testid="settings-btn"]').click();
  await expect(page.locator('[data-testid="settings-modal"]')).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.locator(`[data-testid="settings-tab-${tabId}"]`).click();
}

test.describe("Settings — handlers that narrow event.target", () => {
  test("Enter in the Maps API key field commits the key and drops focus", async ({ page }) => {
    const state = await mockConfig(page, { settings: { extraAllowedTools: [] }, mcp: { servers: [] } });
    await page.goto("/chat");
    await openTab(page, "map");

    const input = page.locator('[data-testid="settings-map-api-key-input"]');
    await input.fill("AIzaTestKey123");
    await input.press("Enter");

    // The handler blurs the input; the blur listener is what saves.
    await expect(input).not.toBeFocused();
    await expect.poll(() => state.settings.googleMapsApiKey).toBe("AIzaTestKey123");
  });

  // The tab mounts before its config GET resolves. Left editable in that
  // window, a key typed into it is overwritten by the arriving stored value
  // and the save that follows sees no change — the key vanishes silently.
  test("the Maps API key field is not editable until the stored key has loaded", async ({ page }) => {
    const state = await mockConfig(page, { settings: { extraAllowedTools: [] }, mcp: { servers: [] } }, SLOW_CONFIG_GET_MS);
    await page.goto("/chat");
    await openTab(page, "map");

    const input = page.locator('[data-testid="settings-map-api-key-input"]');
    await expect(input).toBeDisabled();
    await expect(input).toBeEnabled();

    await input.fill("AIzaLateLoad456");
    await input.press("Enter");
    await expect.poll(() => state.settings.googleMapsApiKey).toBe("AIzaLateLoad456");
  });

  test("unchecking an MCP server's enable box persists enabled: false", async ({ page }) => {
    const state = await mockConfig(page, { settings: { extraAllowedTools: [] }, mcp: { servers: [GMAIL_SERVER] } });
    await page.goto("/chat");
    await openTab(page, "mcp");

    const toggle = page.locator('[data-testid="mcp-enabled-gmail"]');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();

    await expect.poll(() => state.mcp.servers[0]?.spec.enabled).toBe(false);
  });
});
