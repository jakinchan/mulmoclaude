import type { CustomRole } from "./index";
import { isRecord, isStringArray, isUnknownArray } from "../../utils/types";

export const DEFAULT_ROLE_ICON = "person";
const ROLE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Rebuilt field by field rather than asserted: the role list arrives as
// untrusted JSON and every consumer reads `name` / `icon` straight into
// the DOM, so a missing field has to fail here, not in a template.
const parseCustomRole = (value: unknown): CustomRole | null => {
  if (!isRecord(value)) return null;
  const { id, name, icon, prompt, availablePlugins, queries } = value;
  if (typeof id !== "string" || typeof name !== "string" || typeof icon !== "string" || typeof prompt !== "string") return null;
  if (!isStringArray(availablePlugins)) return null;
  const role: CustomRole = { id, name, icon, prompt, availablePlugins };
  return isStringArray(queries) ? { ...role, queries } : role;
};

/** Parse an untrusted `/api/roles` payload into the role list. Returns
 *  null when the value isn't an array of well-formed roles, so callers
 *  keep the state they already had instead of rendering a partial list. */
export const parseCustomRoles = (value: unknown): CustomRole[] | null => {
  if (!isUnknownArray(value)) return null;
  const roles = value.flatMap((entry) => parseCustomRole(entry) ?? []);
  return roles.length === value.length ? roles : null;
};

/** Roles carried by a `POST /api/roles/manage` response, or null when the
 *  response holds no usable list. Null means "keep the list you already
 *  have" — never "the user has no roles", which is what an empty array
 *  would claim. */
export const parseManageRolesResult = (result: unknown): CustomRole[] | null => {
  if (!isRecord(result) || !isRecord(result.data)) return null;
  return parseCustomRoles(result.data.customRoles);
};

export interface RoleForm {
  id: string;
  name: string;
  icon: string;
  prompt: string;
  selectedPlugins: string[];
  queriesText: string;
}

export type RoleFormErrorCode = "idRequired" | "idInvalid" | "nameRequired" | "idDuplicate";

export interface RoleFormError {
  code: RoleFormErrorCode;
  id: string;
}

export const isValidRoleId = (value: string): boolean => ROLE_ID_PATTERN.test(value);

// One newline-separated query per line; blank lines dropped, each trimmed.
export const parseQueriesText = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

// Single source of truth for form → role so create and edit can't drift.
// The icon fallback lives here: an empty icon field must become the default
// on BOTH paths (edit used to persist an empty icon, dropping it everywhere).
export const formToRole = (form: RoleForm): CustomRole => ({
  id: form.id.trim(),
  name: form.name.trim(),
  icon: form.icon.trim() || DEFAULT_ROLE_ICON,
  // Prompt is intentionally NOT trimmed — leading/trailing whitespace can be
  // meaningful in a system prompt.
  prompt: form.prompt,
  availablePlugins: form.selectedPlugins,
  queries: parseQueriesText(form.queriesText),
});

export const roleToForm = (role: CustomRole): RoleForm => ({
  id: role.id,
  name: role.name,
  icon: role.icon,
  prompt: role.prompt,
  selectedPlugins: [...role.availablePlugins],
  queriesText: (role.queries ?? []).join("\n"),
});

// `excludeId` lets rename skip the role's own id when checking for duplicates.
export const validateRoleForm = (form: RoleForm, excludeId: string | null, existingIds: readonly string[]): RoleFormError | null => {
  const trimmedId = form.id.trim();
  if (!trimmedId) return { code: "idRequired", id: trimmedId };
  if (!isValidRoleId(trimmedId)) return { code: "idInvalid", id: trimmedId };
  if (!form.name.trim()) return { code: "nameRequired", id: trimmedId };
  if (existingIds.some((existing) => existing === trimmedId && existing !== excludeId)) {
    return { code: "idDuplicate", id: trimmedId };
  }
  return null;
};
