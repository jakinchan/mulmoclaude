import path from "node:path";
import { BUILTIN_ROLES, RoleSchema, type Role } from "../../src/config/roles.js";
import { WORKSPACE_DIRS, workspacePath } from "./paths.js";
import { readdirUnderSync, readTextUnderSync } from "../utils/files/workspace-io.js";
import { log } from "../system/logger/index.js";

const ROLE_FILE_EXT = ".json";
const LOG_PREFIX = "roles";

// Skipping a broken file keeps one bad role from taking the list down; the problem
// it carries is so the skip isn't also invisible, which is all a hand-placed file
// used to get. `saveRole` writes via JSON.stringify — only humans land here (#2649).
export interface RoleFileProblem {
  message: string;
  data: Record<string, unknown>;
}
type RoleFileOutcome = { role: Role } | { problem: RoleFileProblem };

export function loadCustomRoles(): Role[] {
  const fileNames = readdirUnderSync(workspacePath, WORKSPACE_DIRS.roles);
  const outcomes = fileNames.filter(isRoleFileName).map(readRoleFile);
  [...outcomes.flatMap(problemsOf), ...ignoredEntryProblems(fileNames)].forEach((problem) => log.warn(LOG_PREFIX, problem.message, problem.data));
  return outcomes.flatMap((outcome) => ("role" in outcome ? [outcome.role] : []));
}

export function loadAllRoles(): Role[] {
  const custom = loadCustomRoles();
  const builtIn = BUILTIN_ROLES.filter((role) => !custom.find((customRole) => customRole.id === role.id));
  return [...builtIn, ...custom];
}

export function getRole(roleId: string): Role {
  return loadAllRoles().find((role) => role.id === roleId) ?? BUILTIN_ROLES[0];
}

function isRoleFileName(fileName: string): boolean {
  return fileName.endsWith(ROLE_FILE_EXT);
}

function problemsOf(outcome: RoleFileOutcome): RoleFileProblem[] {
  return "problem" in outcome ? [outcome.problem] : [];
}

function readRoleFile(fileName: string): RoleFileOutcome {
  const read = readRoleText(fileName);
  return "problem" in read ? read : parseRoleFile(fileName, read.text);
}

function readRoleText(fileName: string): { text: string } | { problem: RoleFileProblem } {
  try {
    const text = readTextUnderSync(workspacePath, path.posix.join(WORKSPACE_DIRS.roles, fileName));
    // null is ENOENT only (workspace-io's contract) and readdir just listed it.
    if (text === null) return { problem: { message: "role file disappeared while loading, skipping", data: { fileName } } };
    return { text };
  } catch (err) {
    return { problem: { message: "role file could not be read, skipping", data: { fileName, error: String(err) } } };
  }
}

// Pure: the whole reason a file was dropped, decided from its text alone.
export function parseRoleFile(fileName: string, raw: string): RoleFileOutcome {
  if (raw.trim() === "") {
    return { problem: { message: "role file is empty, skipping", data: { fileName } } };
  }
  const json = parseJson(raw);
  if ("error" in json) {
    return { problem: { message: "role file is not valid JSON, skipping", data: { fileName, error: json.error } } };
  }
  const parsed = RoleSchema.safeParse(json.value);
  if (!parsed.success) {
    return { problem: { message: "role file does not match the role schema, skipping", data: { fileName, issues: summarizeRoleIssues(parsed.error.issues) } } };
  }
  return { role: parsed.data };
}

function parseJson(raw: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    return { error: String(err) };
  }
}

interface RoleIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly errors?: readonly (readonly { readonly message: string }[])[];
}

// zod's raw issues JSON-dump into a log line as a wall of nesting; which field and why
// is what the reader acts on.
function summarizeRoleIssues(issues: readonly RoleIssue[]): string {
  return issues.map((issue) => `${issueField(issue)}: ${issueReason(issue)}`).join("; ");
}

function issueField(issue: RoleIssue): string {
  return issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
}

// A union issue (`availablePlugins`) says only "Invalid input" for itself; the branch
// errors nested under it carry the actionable part ("expected array, received string").
function issueReason(issue: RoleIssue): string {
  const nested = [...new Set((issue.errors ?? []).flat().map((branch) => branch.message))].filter((message) => message !== issue.message);
  return nested.length > 0 ? `${issue.message} (${nested.join(" / ")})` : issue.message;
}

// A `.md` / `.jsonc` / `.json.txt` file never reaches the loader, so it would be as
// invisible as a broken one. Dotfiles are nobody's role attempt (as in collections).
function ignoredEntryProblems(fileNames: string[]): RoleFileProblem[] {
  const ignored = fileNames.filter((fileName) => !isRoleFileName(fileName) && !fileName.startsWith("."));
  if (ignored.length === 0) return [];
  return [
    {
      message: `ignoring entries that are not ${ROLE_FILE_EXT} files — a custom role must be <id>${ROLE_FILE_EXT}`,
      data: { dir: WORKSPACE_DIRS.roles, ignored },
    },
  ];
}
