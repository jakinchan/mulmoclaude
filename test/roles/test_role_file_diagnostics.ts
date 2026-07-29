// #2649: a hand-placed `config/roles/<id>.json` that was empty, malformed, or
// schema-invalid used to be dropped by a bare `catch { return []; }` — the role
// simply never appeared and nothing was logged, so the user could not tell a
// wrong path from a wrong schema. Skipping the file is still correct; being
// silent about it is not.

import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// paths.ts resolves `workspacePath` from the environment when it is first
// evaluated, so the workspace has to exist before anything imports it — hence
// the sync mkdtemp and the awaited imports below rather than a `before()` hook.
const workspaceRoot = mkdtempSync(path.join(tmpdir(), "mulmoclaude-roles-test-"));
process.env.MULMOCLAUDE_WORKSPACE_PATH = workspaceRoot;

const { WORKSPACE_DIRS } = await import("../../server/workspace/paths.js");
const { parseRoleFile, loadCustomRoles } = await import("../../server/workspace/roles.js");

const rolesDir = path.join(workspaceRoot, WORKSPACE_DIRS.roles);

after(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

const VALID_ROLE = {
  id: "reviewer",
  name: "Reviewer",
  icon: "star",
  prompt: "You review things.",
  availablePlugins: ["presentHTML"],
};

const SCHEMA_INVALID = '{ "id": "test", "name": "Test" }'; // icon / prompt / availablePlugins absent — the issue's repro

const roleOf = (outcome: ReturnType<typeof parseRoleFile>) => ("role" in outcome ? outcome.role : undefined);
const problemOf = (outcome: ReturnType<typeof parseRoleFile>) => ("problem" in outcome ? outcome.problem : undefined);

describe("parseRoleFile", () => {
  it("returns the role for a valid file", () => {
    assert.deepEqual(roleOf(parseRoleFile("reviewer.json", JSON.stringify(VALID_ROLE))), VALID_ROLE);
  });

  it("reports an empty file as empty, not as a schema failure", () => {
    const problem = problemOf(parseRoleFile("blank.json", ""));
    assert.match(problem?.message ?? "", /empty/);
    assert.equal(problem?.data.fileName, "blank.json");
  });

  it("treats a whitespace-only file as empty", () => {
    assert.match(problemOf(parseRoleFile("blank.json", "\n  \t\n"))?.message ?? "", /empty/);
  });

  it("reports a JSON syntax error with the parser's own message", () => {
    const problem = problemOf(parseRoleFile("trailing.json", '{ "id": "a", "name": "A", }'));
    assert.match(problem?.message ?? "", /not valid JSON/);
    assert.equal(problem?.data.fileName, "trailing.json");
    assert.match(String(problem?.data.error), /JSON/);
  });

  it("names every missing field for the repro in the issue", () => {
    const problem = problemOf(parseRoleFile("test.json", SCHEMA_INVALID));
    assert.match(problem?.message ?? "", /role schema/);
    const issues = String(problem?.data.issues);
    ["icon", "prompt", "availablePlugins"].forEach((field) => assert.match(issues, new RegExp(field), `missing ${field} in: ${issues}`));
  });

  it("reports the path of a nested type error down to the element", () => {
    const broken = { ...VALID_ROLE, queries: ["ok", 42] };
    const issues = String(problemOf(parseRoleFile("reviewer.json", JSON.stringify(broken)))?.data.issues);
    assert.match(issues, /queries\.1/, issues);
  });

  it("unwraps a union issue so a bare string in availablePlugins says what was expected", () => {
    const broken = { ...VALID_ROLE, availablePlugins: "presentHTML" };
    const issues = String(problemOf(parseRoleFile("reviewer.json", JSON.stringify(broken)))?.data.issues);
    assert.match(issues, /availablePlugins:.*expected array, received string/, issues);
  });

  it("reports a top-level non-object as a root issue", () => {
    const issues = String(problemOf(parseRoleFile("array.json", "[]"))?.data.issues);
    assert.match(issues, /\(root\)/, issues);
  });
});

// warn goes to stderr; capturing it is how test_logBackgroundError.ts asserts on
// log output without wiring DI into the logger.
function captureStderr<T>(func: () => T): { result: T; out: string } {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: func(), out: chunks.join("") };
  } finally {
    process.stderr.write = originalWrite;
  }
}

describe("loadCustomRoles diagnostics", () => {
  beforeEach(async () => {
    await rm(rolesDir, { recursive: true, force: true });
    await mkdir(rolesDir, { recursive: true });
  });

  const place = (fileName: string, content: string) => writeFile(path.join(rolesDir, fileName), content, "utf-8");

  it("warns about each unloadable file by name while still returning the good ones", async () => {
    await place("reviewer.json", JSON.stringify(VALID_ROLE));
    await place("test.json", SCHEMA_INVALID);
    await place("trailing.json", '{ "id": "t", }');
    await place("blank.json", "");
    await place("notes.md", "# not a role");
    await place(".DS_Store", "");

    const { result, out } = captureStderr(() => loadCustomRoles());

    assert.deepEqual(
      result.map((role) => role.id),
      ["reviewer"],
    );
    assert.match(out, /test\.json/);
    assert.match(out, /role schema/);
    assert.match(out, /trailing\.json/);
    assert.match(out, /not valid JSON/);
    assert.match(out, /blank\.json/);
    assert.match(out, /empty/);
    assert.match(out, /notes\.md/);
    assert.ok(!out.includes("DS_Store"), `dotfiles must not be reported: ${out}`);
    assert.ok(!out.includes("reviewer.json"), `the loadable role must not be reported: ${out}`);
  });

  it("names an entry it could not read at all, and still loads the rest", async () => {
    await place("reviewer.json", JSON.stringify(VALID_ROLE));
    await mkdir(path.join(rolesDir, "backup.json")); // a directory readdir lists but read cannot open

    const { result, out } = captureStderr(() => loadCustomRoles());

    assert.deepEqual(
      result.map((role) => role.id),
      ["reviewer"],
    );
    // The errno differs by platform (EISDIR / EPERM), so assert only on what we say.
    assert.match(out, /could not be read/);
    assert.match(out, /backup\.json/);
  });

  // A dangling symlink is the one deterministic way to make readdir and read
  // disagree — deleting the file first would just drop it from the listing.
  it("reports a file that vanished between listing and read", { skip: process.platform === "win32" }, async () => {
    await symlink(path.join(rolesDir, "gone.json"), path.join(rolesDir, "ghost.json"));

    const { result, out } = captureStderr(() => loadCustomRoles());

    assert.equal(result.length, 0);
    assert.match(out, /disappeared while loading/);
    assert.match(out, /ghost\.json/);
  });

  it("says nothing when every file loads", async () => {
    await place("reviewer.json", JSON.stringify(VALID_ROLE));

    const { result, out } = captureStderr(() => loadCustomRoles());

    assert.equal(result.length, 1);
    assert.equal(out, "");
  });

  it("says nothing for an empty roles directory", () => {
    const { result, out } = captureStderr(() => loadCustomRoles());

    assert.deepEqual(result, []);
    assert.equal(out, "");
  });

  it("says nothing when the roles directory does not exist — a fresh install must be quiet", async () => {
    await rm(rolesDir, { recursive: true, force: true });

    const { result, out } = captureStderr(() => loadCustomRoles());

    assert.deepEqual(result, []);
    assert.equal(out, "");
  });

  it("keeps warning on every load, so a user who starts reading the log later still sees why", async () => {
    await place("test.json", SCHEMA_INVALID);

    const first = captureStderr(() => loadCustomRoles());
    const second = captureStderr(() => loadCustomRoles());

    assert.match(first.out, /test\.json/);
    assert.match(second.out, /test\.json/);
  });
});
