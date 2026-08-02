// Pluggable name validation. The full npm package-name spec is
// elaborate (see `validate-npm-package-name`); we implement the
// subset that matters for plugin scaffolding: lowercase, no spaces,
// optional `@scope/` prefix, hyphenated segments, length bound.
//
// The validator is exported so tests can pin every accept/reject
// case.

import { builtinModules } from "node:module";

const MAX_LENGTH = 214; // npm spec — total length including scope

// Names npm itself rejects on publish — guarding here so the user
// doesn't get a clean scaffold and then hit a publish failure later.
// Sources: validate-npm-package-name's blacklist + builtinModules.
// Scoped names are exempt (npm allows `@scope/http`); we only check
// the unscoped path.
const RESERVED_NAMES = new Set<string>(["node_modules", "favicon.ico", ...builtinModules]);

function isSegmentChar(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "." || char === "_" || char === "-";
}

function isAlnum(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
}

function isValidSegment(seg: string): boolean {
  const [firstChar] = seg;
  const lastChar = seg.at(-1);
  // Both are absent only for the empty string, which is never a valid segment.
  if (firstChar === undefined || lastChar === undefined) return false;
  if (!isAlnum(firstChar)) return false;
  if (!isAlnum(lastChar)) return false;
  for (const char of seg) {
    if (!isSegmentChar(char)) return false;
  }
  return true;
}

export interface ValidationResult {
  ok: boolean;
  /** Human-readable error message; empty string when ok. */
  reason: string;
}

const OK_RESULT: ValidationResult = { ok: true, reason: "" };

function reject(reason: string): ValidationResult {
  return { ok: false, reason };
}

export function validatePluginName(raw: string): ValidationResult {
  if (typeof raw !== "string") return reject("name must be a string");
  if (raw.length === 0) return reject("name is required");
  if (raw.length > MAX_LENGTH) return reject(`name too long (max ${MAX_LENGTH} chars)`);
  if (raw !== raw.toLowerCase()) return reject("name must be lowercase");
  if (/\s/.test(raw)) return reject("name must not contain whitespace");

  if (raw.startsWith("@")) return validateScoped(raw);
  return validateUnscoped(raw);
}

function validateScoped(raw: string): ValidationResult {
  const slash = raw.indexOf("/");
  if (slash < 0) return reject("scoped name must include `/`");
  const scope = raw.slice(1, slash); // drop leading `@`
  const local = raw.slice(slash + 1);
  if (scope.length === 0) return reject("scope is empty");
  if (local.length === 0) return reject("local name is empty");
  if (!isValidSegment(scope)) return reject(`invalid scope: ${scope}`);
  if (!isValidSegment(local)) return reject(`invalid local name: ${local}`);
  return OK_RESULT;
}

function validateUnscoped(raw: string): ValidationResult {
  if (raw.startsWith(".") || raw.startsWith("_")) return reject("name must not start with `.` or `_`");
  if (!isValidSegment(raw)) return reject(`invalid name: ${raw}`);
  if (RESERVED_NAMES.has(raw)) return reject(`name is reserved (npm/Node built-in): ${raw}`);
  return OK_RESULT;
}

// Extract the directory name from a package name. For unscoped names
// this is the name itself; for scoped names we use the local part so
// `npx create-mulmoclaude-plugin @example/foo` lands in `foo/`, which
// is what `npm init` and friends do too.
export function directoryNameFor(packageName: string): string {
  if (packageName.startsWith("@")) {
    const slash = packageName.indexOf("/");
    return packageName.slice(slash + 1);
  }
  return packageName;
}
