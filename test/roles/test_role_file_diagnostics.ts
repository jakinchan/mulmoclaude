// #2649: a hand-placed `config/roles/<id>.json` that was empty, malformed, or
// schema-invalid used to be dropped by a bare `catch { return []; }` — the role
// simply never appeared and nothing was logged, so the user could not tell a
// wrong path from a wrong schema. Skipping the file is still correct; being
// silent about it is not.
//
// #2656 is the other half: the file loads fine but doesn't line up — its name
// disagrees with the `id` inside it (listed, yet delete / update say "not found"),
// or two files claim one id and the loser is dropped by readdir order. Neither is
// a reason to skip the file, so these only warn.

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
const { parseRoleFile, loadCustomRoles, fileNameMismatchProblems, duplicateIdProblems } = await import("../../server/workspace/roles.js");
const { roleExists } = await import("../../server/utils/files/roles-io.js");

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

  it("keeps the file name with the loaded role, so the mismatch check has both", () => {
    const outcome = parseRoleFile("designer.json", JSON.stringify(VALID_ROLE));
    assert.equal("fileName" in outcome ? outcome.fileName : undefined, "designer.json");
  });
});

const roleWithId = (roleId: string) => ({ ...VALID_ROLE, id: roleId });

describe("fileNameMismatchProblems", () => {
  it("says nothing when the file name is the id", () => {
    assert.deepEqual(fileNameMismatchProblems({ fileName: "reviewer.json", role: roleWithId("reviewer") }), []);
  });

  it("reports both the file name and the id", () => {
    const [problem, ...rest] = fileNameMismatchProblems({ fileName: "designer.json", role: roleWithId("myrole") });
    assert.deepEqual(rest, []);
    assert.deepEqual(problem?.data, { fileName: "designer.json", id: "myrole" });
  });

  it("names both ways out, since neither name nor id is authoritative", () => {
    const message = fileNameMismatchProblems({ fileName: "designer.json", role: roleWithId("myrole") })[0]?.message ?? "";
    assert.match(message, /myrole\.json/, message); // rename the file
    assert.match(message, /"designer"/, message); // or change the id
  });

  // `manageRoles` validates ids against `isValidRoleId`, so a file name it rejects is
  // neither a savable id nor a delete handle — offering it would be wrong advice.
  it("offers only the rename when the file name is not a usable role id", () => {
    const message = fileNameMismatchProblems({ fileName: "my role.json", role: roleWithId("myrole") })[0]?.message ?? "";
    assert.match(message, /myrole\.json/, message);
    assert.match(message, /not a usable role id/, message);
    assert.ok(!message.includes('"my role"'), `must not suggest an id manageRoles rejects: ${message}`);
  });
});

describe("duplicateIdProblems", () => {
  it("says nothing when every id is unique", () => {
    const loaded = [
      { fileName: "a.json", role: roleWithId("a") },
      { fileName: "b.json", role: roleWithId("b") },
    ];
    assert.deepEqual(duplicateIdProblems(loaded), []);
  });

  it("reports the first file as the used one and the rest as ignored", () => {
    const loaded = [
      { fileName: "first.json", role: roleWithId("dup") },
      { fileName: "second.json", role: roleWithId("dup") },
      { fileName: "third.json", role: roleWithId("dup") },
    ];
    const [problem, ...rest] = duplicateIdProblems(loaded);
    assert.deepEqual(rest, []);
    assert.deepEqual(problem?.data, { id: "dup", used: "first.json", ignored: ["second.json", "third.json"] });
  });

  it("reports one problem per duplicated id and leaves unique ones out", () => {
    const loaded = [
      { fileName: "x1.json", role: roleWithId("x") },
      { fileName: "only.json", role: roleWithId("only") },
      { fileName: "y1.json", role: roleWithId("y") },
      { fileName: "x2.json", role: roleWithId("x") },
      { fileName: "y2.json", role: roleWithId("y") },
    ];
    assert.deepEqual(
      duplicateIdProblems(loaded).map((problem) => problem.data.id),
      ["x", "y"],
    );
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

  // #2656: the role is listed under the id from its contents, but delete / update look
  // for `<id>.json` — so it shows up and then reports "not found".
  it("warns when a file name and its id disagree, and still loads the role", async () => {
    await place("designer.json", JSON.stringify({ ...VALID_ROLE, id: "myrole" }));

    const { result, out } = captureStderr(() => loadCustomRoles());

    assert.deepEqual(
      result.map((role) => role.id),
      ["myrole"],
    );
    assert.match(out, /designer\.json/);
    assert.match(out, /myrole/);
    assert.match(out, /does not match its file name/);
  });

  // What the warning and the help doc tell the user to do has to be true: the listed id
  // is not a handle, the file name still is.
  it("keeps the mismatched role addressable by its file name, not by its listed id", async () => {
    await place("designer.json", JSON.stringify({ ...VALID_ROLE, id: "myrole" }));

    assert.equal(roleExists("myrole"), false);
    assert.equal(roleExists("designer"), true);
  });

  // Which of the two wins is readdir order, so the duplicate line has to name both;
  // asserting on the line itself keeps the mismatch warning for copy.json out of it.
  it("warns when two files declare the same id, naming both", async () => {
    await place("shared.json", JSON.stringify({ ...VALID_ROLE, id: "shared" }));
    await place("copy.json", JSON.stringify({ ...VALID_ROLE, id: "shared", name: "Copy" }));

    const { result, out } = captureStderr(() => loadCustomRoles());

    assert.equal(result.length, 2);
    const line = out.split("\n").find((candidate) => candidate.includes("declares the same id")) ?? "";
    assert.match(line, /id=shared/, out);
    assert.match(line, /shared\.json/, out);
    assert.match(line, /copy\.json/, out);
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
