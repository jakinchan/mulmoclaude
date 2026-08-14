// E2E for a field-level `default` on an enum. The Add form is the primary
// payoff of the feature: a task collection whose status is almost always
// "todo" should open on it, so adding a record is one click rather than the
// same two picks every time.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

const TASKS_DETAIL = {
  collection: {
    slug: "tasks",
    title: "Tasks",
    icon: "task_alt",
    source: "user",
    schema: {
      title: "Tasks",
      icon: "task_alt",
      dataPath: "data/tasks/items",
      primaryKey: "id",
      fields: {
        id: { type: "string", label: "ID", primary: true, required: true },
        title: { type: "string", label: "Title", required: true },
        // Required AND defaulted: the default satisfies the requirement.
        status: { type: "enum", label: "Status", values: ["todo", "doing", "done"], required: true, default: "todo" },
        priority: { type: "enum", label: "Priority", values: ["high", "low"], default: "low" },
        // No default — must stay blank, so the pre-fill is provably per-field.
        assignee: { type: "enum", label: "Assignee", values: ["ada", "grace"] },
      },
    },
  },
  items: [{ id: "t1", title: "Existing", status: "doing", priority: "high", assignee: "ada" }],
};

async function mockTasks(page: Page, detail: unknown = TASKS_DETAIL): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/collections/tasks",
    (route) => route.fulfill({ json: detail }),
  );
}

test.describe("collection enum field default", () => {
  test("the Add form opens on the declared defaults, and leaves undeclared fields blank", async ({ page }) => {
    await mockAllApis(page);
    await mockTasks(page);
    await page.goto("/collections/tasks");
    await page.getByTestId("collections-row-t1").waitFor();

    await page.getByTestId("collections-add-item").click();
    await expect(page.getByTestId("collections-edit-title")).toBeVisible();

    await expect(page.getByTestId("collections-input-status")).toHaveValue("todo");
    await expect(page.getByTestId("collections-input-priority")).toHaveValue("low");
    await expect(page.getByTestId("collections-input-assignee")).toHaveValue("");
  });

  // Opening an existing record must show what it stores, not what a new one
  // would start on — a default that leaked into the edit form would rewrite
  // the record on the next save.
  test("editing an existing record still shows its own values", async ({ page }) => {
    await mockAllApis(page);
    await mockTasks(page);
    // Deep link rather than a row click: a row cell can carry its own link,
    // and the click target is not what this test is about.
    await page.goto("/collections/tasks?selected=t1");
    await expect(page.getByTestId("collections-detail")).toBeVisible();

    await page.getByTestId("collections-detail-edit").click();
    await expect(page.getByTestId("collections-input-status")).toHaveValue("doing");
    await expect(page.getByTestId("collections-input-priority")).toHaveValue("high");
  });

  // A file written before the feature existed can carry a default the values
  // no longer offer. The collection must still load, and the form starts blank
  // rather than on an impossible value that would fail the save.
  test("a stale default outside the values leaves the field blank, collection intact", async ({ page }) => {
    const stale = JSON.parse(JSON.stringify(TASKS_DETAIL)) as typeof TASKS_DETAIL;
    stale.collection.schema.fields.status.default = "未着手";
    await mockAllApis(page);
    await mockTasks(page, stale);
    await page.goto("/collections/tasks");

    await expect(page.getByTestId("collections-row-t1")).toBeVisible();
    await page.getByTestId("collections-add-item").click();
    await expect(page.getByTestId("collections-input-status")).toHaveValue("");
    await expect(page.getByTestId("collections-input-priority")).toHaveValue("low");
  });
});

// `primary` lives on every field type, so an enum can be the primary key. The
// id pre-fill must not stomp its default: a generated UUID is not one of the
// enum's values, so the form would open blank on a field that cannot be saved
// (Codex review on #2910).
test.describe("enum primary key", () => {
  const PHASES_DETAIL = {
    collection: {
      slug: "phases",
      title: "Phases",
      icon: "list",
      source: "user",
      schema: {
        title: "Phases",
        icon: "list",
        dataPath: "data/phases/items",
        primaryKey: "phase",
        fields: {
          phase: { type: "enum", label: "Phase", values: ["intake", "review"], primary: true, required: true, default: "intake" },
          note: { type: "string", label: "Note" },
        },
      },
    },
    items: [{ phase: "review", note: "existing" }],
  };

  test("the Add form opens on the declared default, not a generated id", async ({ page }) => {
    await mockAllApis(page);
    await page.route(
      (url) => url.pathname === "/api/collections/phases",
      (route) => route.fulfill({ json: PHASES_DETAIL }),
    );
    await page.goto("/collections/phases");
    await page.getByTestId("collections-row-review").waitFor();

    await page.getByTestId("collections-add-item").click();
    await expect(page.getByTestId("collections-input-phase")).toHaveValue("intake");
  });
});

// A field may be named `__proto__` — JSON.parse gives it as an own key, so it
// reaches the form like any other. Building the draft by assignment would run
// the prototype setter for that one name and the field would have no slot at
// all: blank, and un-typeable (Codex review on #2910).
test("a field named __proto__ gets its default like any other", async ({ page }) => {
  const PROTO_KEY = "__proto__";
  const detail = {
    collection: {
      slug: "odd",
      title: "Odd",
      icon: "list",
      source: "user",
      schema: {
        title: "Odd",
        icon: "list",
        dataPath: "data/odd/items",
        primaryKey: "id",
        fields: {
          id: { type: "string", label: "ID", primary: true, required: true },
          [PROTO_KEY]: { type: "enum", label: "Proto", values: ["todo", "done"], default: "todo" },
        },
      },
    },
    items: [{ id: "o1" }],
  };
  await mockAllApis(page);
  await page.route(
    (url) => url.pathname === "/api/collections/odd",
    (route) => route.fulfill({ json: detail }),
  );
  await page.goto("/collections/odd");
  await page.getByTestId("collections-row-o1").waitFor();

  await page.getByTestId("collections-add-item").click();
  await expect(page.getByTestId(`collections-input-${PROTO_KEY}`)).toHaveValue("todo");
  // The ordinary primary key still gets its generated id.
  await expect(page.getByTestId("collections-input-id")).not.toHaveValue("");
});

// The edit path builds its own draft maps, and without a slot the field cannot
// be edited at all — the form would show the record as empty and a save would
// drop what it stores (CodeRabbit on #2910).
test("a field named __proto__ is editable, showing what the record stores", async ({ page }) => {
  const PROTO_KEY = "__proto__";
  const detail = {
    collection: {
      slug: "odd",
      title: "Odd",
      icon: "list",
      source: "user",
      schema: {
        title: "Odd",
        icon: "list",
        dataPath: "data/odd/items",
        primaryKey: "id",
        fields: {
          id: { type: "string", label: "ID", primary: true, required: true },
          [PROTO_KEY]: { type: "enum", label: "Proto", values: ["todo", "done"], default: "todo" },
        },
      },
    },
    items: [
      Object.fromEntries([
        ["id", "o1"],
        [PROTO_KEY, "done"],
      ]),
    ],
  };
  await mockAllApis(page);
  await page.route(
    (url) => url.pathname === "/api/collections/odd",
    (route) => route.fulfill({ json: detail }),
  );
  await page.goto("/collections/odd?selected=o1");
  await expect(page.getByTestId("collections-detail")).toBeVisible();

  await page.getByTestId("collections-detail-edit").click();
  await expect(page.getByTestId(`collections-input-${PROTO_KEY}`)).toHaveValue("done");
});
