// Opening balance ("year-start B/S") logic. Adoption flow: a user
// migrating from another bookkeeping system enters their existing
// asset / liability / equity balances as of a chosen `asOfDate`,
// instead of replaying their entire historical journal.
//
// Stored as a single `kind: "opening"` entry in the regular journal
// — keeps the journal as the single source of truth, and makes
// reports treat the opening as just an early entry without special
// branches in aggregation.
//
// Replacing an existing opening: void the old, append the new. The
// route handler is responsible for ordering this with snapshot
// invalidation so the "before" snapshots get dropped.

import { isUnknownArray } from "@mulmoclaude/common";

import type { Account, JournalEntry, JournalLine } from "../shared/types.js";
import { BALANCE_SHEET_ACCOUNT_TYPES } from "../shared/types.js";
import { isValidCalendarDate, netBalance, parseJournalLine, voidedIdSet } from "./journal.js";

const EQUALITY_TOLERANCE = 0.005;

export interface OpeningValidationError {
  field: string;
  message: string;
}

export type OpeningParseResult = { ok: true; lines: JournalLine[] } | { ok: false; errors: OpeningValidationError[] };

/** Find the existing opening entry for a book, if any. Multiple
 *  openings shouldn't coexist (the route enforces void-then-append),
 *  but if they do the most recent by `createdAt` wins so callers
 *  always see one canonical opening. */
export function findActiveOpening(entries: readonly JournalEntry[]): JournalEntry | null {
  const voided = voidedIdSet(entries);
  let active: JournalEntry | null = null;
  for (const entry of entries) {
    if (entry.kind !== "opening") continue;
    if (voided.has(entry.id)) continue;
    if (!active || entry.createdAt > active.createdAt) active = entry;
  }
  return active;
}

interface OpeningParseInput {
  asOfDate: string;
  lines: unknown;
  accounts: readonly Account[];
  existingEntries: readonly JournalEntry[];
}

function validateOpeningAccount(line: JournalLine, idx: number, accountByCode: ReadonlyMap<string, Account>, errors: OpeningValidationError[]): void {
  const acct = accountByCode.get(line.accountCode);
  if (!acct) {
    errors.push({ field: `lines[${idx}].accountCode`, message: `unknown account code ${JSON.stringify(line.accountCode)}` });
    return;
  }
  if (!BALANCE_SHEET_ACCOUNT_TYPES.includes(acct.type)) {
    errors.push({
      field: `lines[${idx}].accountCode`,
      message: `account ${acct.code} is type ${acct.type}; opening balances may only reference balance-sheet accounts (asset / liability / equity)`,
    });
  }
}

/** Opening lines are narrowed by the same shape parser the journal
 *  uses, but they answer to different rules afterwards: balance-sheet
 *  accounts only, and no "exactly one side" requirement — the opening
 *  form lets a user carry both columns on one account. */
function parseOpeningLines(raw: readonly unknown[], accounts: readonly Account[], errors: OpeningValidationError[]): JournalLine[] {
  const accountByCode = new Map(accounts.map((account) => [account.code, account]));
  const lines: JournalLine[] = [];
  raw.forEach((rawLine, idx) => {
    const line = parseJournalLine(rawLine, idx, errors);
    if (line === null) return;
    validateOpeningAccount(line, idx, accountByCode, errors);
    lines.push(line);
  });
  return lines;
}

function validateAsOfPredatesEverything(input: { asOfDate: string; existingEntries: readonly JournalEntry[] }, errors: OpeningValidationError[]): void {
  // The point of the rule is "you can't enter an opening dated
  // 2026-01-01 if you've already booked transactions in December
  // 2025" — that would silently change the meaning of those
  // December transactions. Existing openings (about to be
  // replaced) and already-voided entries are exempt.
  const voided = voidedIdSet(input.existingEntries);
  for (const entry of input.existingEntries) {
    if (entry.kind === "opening") continue;
    if (entry.kind === "void-marker") continue;
    if (voided.has(entry.id)) continue;
    if (entry.date < input.asOfDate) {
      errors.push({
        field: "asOfDate",
        message: `cannot set opening as of ${input.asOfDate}: existing entry ${entry.id} dated ${entry.date} is older. Void it first or pick an earlier asOfDate.`,
      });
      break; // one error is enough — listing every conflicting entry would be noisy
    }
  }
}

/** Parse the inputs for `setOpeningBalances`, returning the narrowed
 *  lines so the caller can persist what was actually checked. Caller
 *  passes the full list of journal entries in the book so we can check
 *  the "asOfDate must precede every other entry" rule. An opening with
 *  zero lines is accepted as a no-op marker — it satisfies the
 *  "book has an opening" gate the UI uses without committing the
 *  user to specific balances on day one (they can replace it
 *  later). */
export function parseOpening(input: OpeningParseInput): OpeningParseResult {
  const errors: OpeningValidationError[] = [];
  if (!isValidCalendarDate(input.asOfDate)) {
    errors.push({ field: "asOfDate", message: `expected YYYY-MM-DD calendar date, got ${JSON.stringify(input.asOfDate)}` });
  }
  if (!isUnknownArray(input.lines)) {
    errors.push({ field: "lines", message: "lines must be an array" });
    return { ok: false, errors };
  }
  const lines = parseOpeningLines(input.lines, input.accounts, errors);
  const net = netBalance(lines);
  if (Math.abs(net) > EQUALITY_TOLERANCE) {
    errors.push({ field: "lines", message: `Σ debit − Σ credit = ${net.toFixed(4)}; opening must balance` });
  }
  validateAsOfPredatesEverything(input, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, lines };
}
