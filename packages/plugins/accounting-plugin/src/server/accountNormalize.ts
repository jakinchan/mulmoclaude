// Pure parsing + normalization for the Account record: `parseAccountInput`
// narrows a wire payload to an `Account`, `normalizeStoredAccount` decides
// what of it reaches disk. Both are pure, so unit tests exercise the
// shape rules + the field-whitelist + the active-flag policy without
// spinning up a file system, and the service-layer `upsertAccount` is
// left with only its file-IO and snapshot-invalidation orchestration.
//
// Policy summary (mirrored in the `upsertAccount` JSDoc):
//   - whitelist: only `code`, `name`, `type`, optional `note`, and
//     `active` are persisted. Unknown keys from a mistyped caller
//     are dropped — this includes the now-removed
//     `tracksTaxRegistration` flag from older books, which is
//     silently sloughed off the next time an account is upserted.
//   - `note`: stored only when a non-empty trimmed string. An
//     empty string is treated the same as omitted.
//   - `active`:
//       explicit `false` → store `false` (deactivate)
//       explicit `true`  → omit (reactivate; default-active)
//       omitted          → inherit from `existing` (preserves
//                          a soft-deleted account when a caller
//                          updates name/type/note without
//                          mentioning the active flag — the bug
//                          coverage that prompted this helper)

import { isRecord } from "@mulmoclaude/common";

import type { Account, AccountType } from "../shared/types.js";
import { ACCOUNT_TYPES } from "../shared/types.js";

export type AccountParseResult = { ok: true; account: Account } | { ok: false; message: string };

function isAccountType(value: unknown): value is AccountType {
  return ACCOUNT_TYPES.some((accountType) => accountType === value);
}

/** Narrow a wire payload to an `Account`. `name` and `type` are as
 *  required as `code`: an account persisted without a type is invisible
 *  to every report, which groups rows by it. */
export function parseAccountInput(raw: unknown): AccountParseResult {
  if (!isRecord(raw)) return { ok: false, message: "account is required — pass an object with code, name, and type" };
  const { code, name, type, note, active } = raw;
  if (typeof code !== "string" || code.length === 0) return { ok: false, message: "account code is required" };
  if (typeof name !== "string" || name.trim() === "") return { ok: false, message: "account name is required" };
  if (!isAccountType(type)) return { ok: false, message: `account type ${JSON.stringify(type)} is invalid — must be one of: ${ACCOUNT_TYPES.join(", ")}` };
  if (note !== undefined && typeof note !== "string") return { ok: false, message: "account note must be a string when supplied" };
  if (active !== undefined && typeof active !== "boolean") return { ok: false, message: "account active must be a boolean when supplied" };
  const account: Account = { code, name, type };
  if (typeof note === "string") account.note = note;
  if (typeof active === "boolean") account.active = active;
  return { ok: true, account };
}

export function normalizeStoredAccount(input: Account, existing?: Account): Account {
  const stored: Account = { code: input.code, name: input.name, type: input.type };
  if (typeof input.note === "string" && input.note.length > 0) stored.note = input.note;
  const inheritInactive = input.active === undefined && existing?.active === false;
  if (input.active === false || inheritInactive) stored.active = false;
  return stored;
}
