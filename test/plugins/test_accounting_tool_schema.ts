// The accounting tool's parameters are a contract with the MODEL, and
// the model must never choose a project.
//
// A project id is an opaque value the SERVER derives from a path (a
// session's cwd, a request's resolved root). An LLM has no way to know
// one, and accepting one from the caller would make the client the
// source of the root — the thing every other part of the multi-root
// work refuses (see plans/feat-accounting-project-root.md). The same
// reasoning already settled `presentCollection`, whose schema is pinned
// the same way.
//
// So a later "helpful" parameter here is a test failure, not a feature.

import { test } from "node:test";
import assert from "node:assert/strict";

import toolDefinition from "../../src/plugins/accounting/definition.js";

const FORBIDDEN_PARAMS = ["project", "projectId", "root", "workspaceRoot", "workspace", "scope", "path"];

test("manageAccounting's schema lets the model name no project or path", () => {
  const { properties } = toolDefinition.parameters as { properties: Record<string, unknown> };
  for (const name of FORBIDDEN_PARAMS) {
    assert.equal(
      Object.hasOwn(properties, name),
      false,
      `manageAccounting must not accept a '${name}' parameter — the host resolves the root from the session`,
    );
  }
});
