// A malformed roles payload must never blank the Roles panel.
//
// `parseCustomRoles` / `parseManageRolesResult` return null for "this payload
// is not a usable list" precisely so the caller can keep what it already has.
// Collapsing that null to `[]` at the call site (the shape codex flagged on
// #2738) puts a user with one hand-edited row in `config/roles/*.json` in
// front of an empty panel — which reads as "my roles were deleted".
//
// The mocks below make BOTH the manage-list response and the follow-up GET
// self-heal malformed, which is what a bad roles file actually looks like:
// with the fix the seeded row survives, with `?? []` nothing repopulates it.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { isRecord } from "../../src/utils/types";

const SEEDED_ROLE = {
  id: "analyst",
  name: "Analyst",
  icon: "insights",
  prompt: "You are an analyst.",
  availablePlugins: ["presentChart"],
};

// Missing name / icon / prompt / availablePlugins — exactly what a
// hand-edited role file yields once a required field is dropped.
const MALFORMED_ROLES = [{ id: "analyst" }];

async function mockRolesApi(page: Page): Promise<void> {
  await mockAllApis(page);

  // The list goes bad the moment the mutation's reload does, so the
  // abort-coordinated GET self-heal can't paper over a blanked panel.
  // (`/api/roles` is read at boot by useRoles as well as on panel mount, so
  // this is keyed off the manage-list call, not a read counter.)
  const state = { listWentBad: false };

  await page.route(
    (url) => url.pathname === "/api/roles",
    (route) => route.fulfill({ json: state.listWentBad ? MALFORMED_ROLES : [SEEDED_ROLE] }),
  );

  // POST /api/roles/manage — the create succeeds, the list reload that
  // follows it comes back unreadable.
  await page.route(
    (url) => url.pathname === "/api/roles/manage",
    (route) => {
      const body: unknown = route.request().postDataJSON();
      const action = isRecord(body) && typeof body.action === "string" ? body.action : "";
      if (action !== "list") return route.fulfill({ json: { success: true } });
      state.listWentBad = true;
      return route.fulfill({ json: { success: true, data: { customRoles: MALFORMED_ROLES } } });
    },
  );
}

async function openRolesTab(page: Page): Promise<void> {
  await page.goto("/chat");
  await page.getByTestId("settings-btn").click();
  await page.getByTestId("settings-tab-roles").click();
  await expect(page.getByTestId("roles-view-root")).toBeVisible();
}

test.describe("Roles panel — a malformed list must not wipe the roles on screen", () => {
  test("keeps the loaded roles and surfaces the staleness after an unreadable refresh", async ({ page }) => {
    await mockRolesApi(page);
    await openRolesTab(page);

    // Seeded role is on screen, and nothing is stale yet.
    await expect(page.getByTestId("role-row-analyst")).toBeVisible();
    await expect(page.getByTestId("roles-list-error")).toHaveCount(0);

    // Create a role — the POST succeeds, so refreshList() runs and gets the
    // malformed list back.
    await page.getByTestId("role-add-btn").click();
    await page.getByPlaceholder("unique-id").fill("writer");
    // The create panel renders id / name / icon in that order, ahead of the list.
    await page.getByTestId("roles-view-root").locator("input[type='text']").nth(1).fill("Writer");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    // Sync point FIRST: the banner only appears once refreshList() has run and
    // rejected the payload. Asserting the row before this would pass against
    // the pre-mutation DOM and prove nothing.
    await expect(page.getByTestId("roles-list-error")).toBeVisible();

    // THE ASSERTION: the roles that were on screen are still on screen.
    // `?? []` at the call site empties the list here, and the follow-up GET is
    // equally unreadable, so nothing puts the row back.
    await expect(page.getByTestId("role-row-analyst")).toBeVisible();
  });
});
