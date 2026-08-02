import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formToRole,
  roleToForm,
  parseCustomRoles,
  parseManageRolesResult,
  parseQueriesText,
  validateRoleForm,
  isValidRoleId,
  DEFAULT_ROLE_ICON,
  type RoleForm,
} from "../../../src/plugins/manageRoles/roleForm.js";

const form = (over: Partial<RoleForm> = {}): RoleForm => ({
  id: "analyst",
  name: "Analyst",
  icon: "insights",
  prompt: "You are an analyst.",
  selectedPlugins: ["chart"],
  queriesText: "",
  ...over,
});

describe("parseQueriesText", () => {
  it("returns [] for empty input", () => {
    assert.deepEqual(parseQueriesText(""), []);
  });

  it("drops blank / whitespace-only lines and trims", () => {
    assert.deepEqual(parseQueriesText("  a \n\n  \n b "), ["a", "b"]);
  });

  it("handles a single line with no newline", () => {
    assert.deepEqual(parseQueriesText("just one"), ["just one"]);
  });

  it("handles CRLF input", () => {
    assert.deepEqual(parseQueriesText("a\r\nb"), ["a", "b"]);
  });
});

describe("formToRole", () => {
  it("trims id and name and splits queries", () => {
    const role = formToRole(form({ id: "  a  ", name: "  A  ", queriesText: "q1\nq2" }));
    assert.equal(role.id, "a");
    assert.equal(role.name, "A");
    assert.deepEqual(role.queries, ["q1", "q2"]);
  });

  // Regression: an empty icon field must fall back on the edit path too —
  // it used to persist "" and drop the icon everywhere.
  it("falls back to the default icon when the field is blank", () => {
    assert.equal(formToRole(form({ icon: "" })).icon, DEFAULT_ROLE_ICON);
    assert.equal(formToRole(form({ icon: "   " })).icon, DEFAULT_ROLE_ICON);
  });

  it("keeps a provided icon", () => {
    assert.equal(formToRole(form({ icon: "star" })).icon, "star");
  });

  // Prompt whitespace can be meaningful — pin that it is NOT trimmed.
  it("does not trim the prompt", () => {
    assert.equal(formToRole(form({ prompt: "  keep  " })).prompt, "  keep  ");
  });
});

describe("roleToForm / round-trip", () => {
  it("joins queries with newlines and copies plugins", () => {
    const result = roleToForm({ id: "a", name: "A", icon: "x", prompt: "p", availablePlugins: ["chart"], queries: ["q1", "q2"] });
    assert.equal(result.queriesText, "q1\nq2");
    assert.deepEqual(result.selectedPlugins, ["chart"]);
  });

  it("treats missing queries as an empty field", () => {
    assert.equal(roleToForm({ id: "a", name: "A", icon: "x", prompt: "p", availablePlugins: [] }).queriesText, "");
  });

  it("round-trips a role back to itself", () => {
    const role = { id: "a", name: "A", icon: "x", prompt: "p", availablePlugins: ["chart"], queries: ["q1"] };
    assert.deepEqual(formToRole(roleToForm(role)), role);
  });
});

describe("isValidRoleId", () => {
  it("accepts alphanumerics, dash and underscore", () => {
    assert.equal(isValidRoleId("my_role-2"), true);
  });

  it("rejects path-traversal and separator characters", () => {
    for (const candidate of ["../x", "a/b", "a.b", "", "a b", "role!"]) {
      assert.equal(isValidRoleId(candidate), false, `${candidate} should be invalid`);
    }
  });
});

describe("validateRoleForm", () => {
  it("passes a valid form", () => {
    assert.equal(validateRoleForm(form(), null, ["other"]), null);
  });

  it("flags an empty id", () => {
    assert.deepEqual(validateRoleForm(form({ id: "   " }), null, []), { code: "idRequired", id: "" });
  });

  it("flags an id with illegal characters", () => {
    assert.equal(validateRoleForm(form({ id: "../evil" }), null, [])?.code, "idInvalid");
  });

  it("flags an empty name", () => {
    assert.equal(validateRoleForm(form({ name: "  " }), null, [])?.code, "nameRequired");
  });

  it("flags a duplicate id", () => {
    assert.equal(validateRoleForm(form({ id: "dup" }), null, ["dup"])?.code, "idDuplicate");
  });

  it("excludes the role's own id on rename", () => {
    assert.equal(validateRoleForm(form({ id: "self" }), "self", ["self"]), null);
  });
});

describe("parseCustomRoles", () => {
  const wireRole = { id: "analyst", name: "Analyst", icon: "insights", prompt: "You are an analyst.", availablePlugins: ["chart"] };

  it("rebuilds a well-formed list and drops unknown fields", () => {
    assert.deepEqual(parseCustomRoles([{ ...wireRole, isDebugRole: true }]), [wireRole]);
  });

  it("keeps queries only when it is a string list", () => {
    assert.deepEqual(parseCustomRoles([{ ...wireRole, queries: ["a", "b"] }]), [{ ...wireRole, queries: ["a", "b"] }]);
    assert.deepEqual(parseCustomRoles([{ ...wireRole, queries: [1] }]), [wireRole]);
  });

  it("accepts an empty list", () => {
    assert.deepEqual(parseCustomRoles([]), []);
  });

  it("returns null for a non-array payload", () => {
    assert.equal(parseCustomRoles(null), null);
    assert.equal(parseCustomRoles({ customRoles: [] }), null);
    assert.equal(parseCustomRoles(undefined), null);
  });

  it("returns null when any entry is malformed, so the caller keeps its list", () => {
    assert.equal(parseCustomRoles([wireRole, { ...wireRole, name: 5 }]), null);
    assert.equal(parseCustomRoles([{ ...wireRole, availablePlugins: "chart" }]), null);
    assert.equal(parseCustomRoles(["analyst"]), null);
  });
});

// `null` from this parser is the "keep the list you already have" signal.
// The refreshList() call sites must not collapse it to `[]` — doing so blanks
// the panel for anyone whose roles file has one hand-edited row (#2738 review).
describe("parseManageRolesResult", () => {
  const wireRole = { id: "analyst", name: "Analyst", icon: "insights", prompt: "You are an analyst.", availablePlugins: ["chart"] };

  it("reads the list out of a manage response envelope", () => {
    assert.deepEqual(parseManageRolesResult({ success: true, data: { customRoles: [wireRole] } }), [wireRole]);
  });

  it("reads an empty list as an empty list", () => {
    assert.deepEqual(parseManageRolesResult({ success: true, data: { customRoles: [] } }), []);
  });

  it("returns null — not [] — when the envelope carries no usable list", () => {
    assert.equal(parseManageRolesResult({ success: true }), null);
    assert.equal(parseManageRolesResult({ success: true, data: {} }), null);
    assert.equal(parseManageRolesResult({ success: true, data: { customRoles: [{ id: "analyst" }] } }), null);
    assert.equal(parseManageRolesResult({ success: true, data: "roles" }), null);
    assert.equal(parseManageRolesResult(null), null);
  });
});
