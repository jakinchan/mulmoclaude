// Pure validation + creation logic for journal entries. No fs access
// here — callers wire the validated entry to `appendJournal` in
// `server/utils/files/accounting-io.ts`.
//
// Double-entry rule: every entry's lines must satisfy
//   Σ debit === Σ credit   (within a tolerance of 0.005 — see
//                            EQUALITY_TOLERANCE below)
//
// Append-only: there is no `editEntry`. Corrections are made by
// `voidEntry` (creates a reversing pair) followed by a fresh
// `addEntries` call for the corrected booking.

import { randomUUID } from "node:crypto";
import { hasStringProp, isRecord, isUnknownArray } from "@mulmoclaude/common";

import { JOURNAL_ENTRY_KINDS } from "../shared/types.js";
import type { Account, JournalEntry, JournalLine } from "../shared/types.js";

/** Floating-point tolerance for the debit = credit check. Currency
 *  amounts arrive as JavaScript numbers (the on-wire format is JSON,
 *  so amounts are doubles). 0.005 keeps two-decimal currency math
 *  honest while accepting the floating-point noise of summing
 *  many lines. */
const EQUALITY_TOLERANCE = 0.005;

/** Defensive cap on `JournalLine.taxRegistrationId`. Real-world IDs
 *  are short (JP T-numbers are 14 chars, EU VAT IDs ≤ 14, GSTIN is
 *  15, ABN is 11). 32 covers every documented format with comfortable
 *  margin while still rejecting accidental paste-bombs. Validation
 *  applies to the *trimmed* value so a string of pure whitespace
 *  doesn't trip the limit (it normalises to absent). */
export const MAX_TAX_REGISTRATION_ID_LENGTH = 32;

export interface ValidationError {
  field: string;
  message: string;
}

/** The fields `parseEntry` proves about one wire entry. `makeEntry`
 *  takes this, so an entry can only be built from input something
 *  actually checked. */
export interface ParsedEntry {
  date: string;
  lines: JournalLine[];
  memo?: string | undefined;
  replacesEntryId?: string | undefined;
}

export type EntryParseResult = { ok: true; entry: ParsedEntry } | { ok: false; errors: ValidationError[] };

function lineHasExactlyOneSide(line: JournalLine): boolean {
  const hasDebit = typeof line.debit === "number" && line.debit !== 0;
  const hasCredit = typeof line.credit === "number" && line.credit !== 0;
  return hasDebit !== hasCredit;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Build today's `YYYY-MM-DD` from the host's local timezone.
 *  Centralised here so server-side defaults (the void-date on
 *  `voidEntry`, the today() stamp on opening replacements, etc.)
 *  agree with the client-side `localDateString()` from
 *  `src/plugins/accounting/dates.ts`. `toISOString().slice(0, 10)`
 *  would emit a UTC date instead — which silently flips into
 *  tomorrow / yesterday in negative-offset timezones. */
export function localDateString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Validate that `date` is both shaped as YYYY-MM-DD AND represents
 *  a real calendar day. The bare regex accepts impossible values
 *  like 2026-02-31 or 2026-13-01 which would then poison
 *  `periodFromDate`, sort orders, and snapshot keys. We reparse
 *  through the Date constructor and roundtrip-format to catch
 *  silent normalisation (e.g. "2026-02-30" → Mar 02). */
export function isValidCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split("-").map((segment) => parseInt(segment, 10));
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** Returns Σ debit − Σ credit. Used by callers that need the actual
 *  imbalance value (e.g. the OpeningBalancesForm shows live diff). */
export function netBalance(lines: readonly JournalLine[]): number {
  let net = 0;
  for (const line of lines) {
    if (typeof line.debit === "number") net += line.debit;
    if (typeof line.credit === "number") net -= line.credit;
  }
  return net;
}

function checkTaxRegistrationId(value: unknown, idx: number, errors: ValidationError[]): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    errors.push({ field: `lines[${idx}].taxRegistrationId`, message: "must be a string" });
    return;
  }
  if (value.trim().length > MAX_TAX_REGISTRATION_ID_LENGTH) {
    errors.push({
      field: `lines[${idx}].taxRegistrationId`,
      message: `must be at most ${MAX_TAX_REGISTRATION_ID_LENGTH} characters (got ${value.trim().length})`,
    });
  }
}

/** One issue per bad field, so a caller fixing a line learns about all
 *  of them at once. Returns whether the line came through clean. */
function checkLineFields(raw: Record<string, unknown>, idx: number, errors: ValidationError[]): boolean {
  const issuesBefore = errors.length;
  const { accountCode, debit, credit, memo, taxRegistrationId } = raw;
  if (typeof accountCode !== "string") errors.push({ field: `lines[${idx}].accountCode`, message: "accountCode must be a string" });
  if (debit !== undefined && !isNonNegativeNumber(debit)) errors.push({ field: `lines[${idx}].debit`, message: "debit must be a non-negative finite number" });
  if (credit !== undefined && !isNonNegativeNumber(credit))
    errors.push({ field: `lines[${idx}].credit`, message: "credit must be a non-negative finite number" });
  if (memo !== undefined && typeof memo !== "string") errors.push({ field: `lines[${idx}].memo`, message: "memo must be a string" });
  checkTaxRegistrationId(taxRegistrationId, idx, errors);
  return errors.length === issuesBefore;
}

/** Re-tested rather than assigned straight through: `checkLineFields`
 *  proved each of these, but only a `typeof` narrows them for the
 *  compiler. */
function buildLine(raw: Record<string, unknown>): JournalLine | null {
  const { accountCode, debit, credit, memo, taxRegistrationId } = raw;
  if (typeof accountCode !== "string") return null;
  const line: JournalLine = { accountCode };
  if (typeof debit === "number") line.debit = debit;
  if (typeof credit === "number") line.credit = credit;
  if (typeof memo === "string") line.memo = memo;
  if (typeof taxRegistrationId === "string") line.taxRegistrationId = taxRegistrationId;
  return line;
}

/** Narrow one wire value to a `JournalLine`, pushing an issue per bad
 *  field. Shape only: account existence and the debit/credit-side rule
 *  belong to the caller, because journal entries and opening balances
 *  disagree about them. Returns null when nothing usable came out —
 *  the caller drops the line rather than reading fields off it. */
export function parseJournalLine(raw: unknown, idx: number, errors: ValidationError[]): JournalLine | null {
  if (!isRecord(raw)) {
    errors.push({ field: `lines[${idx}]`, message: "each line must be an object with an accountCode and a debit or credit amount" });
    return null;
  }
  if (!checkLineFields(raw, idx, errors)) return null;
  return buildLine(raw);
}

/** The rules a journal line answers to on top of its shape: the code
 *  must name a real account, and exactly one side carries an amount. */
function validateEntryLine(line: JournalLine, idx: number, accountCodes: ReadonlySet<string>, errors: ValidationError[]): void {
  if (!line.accountCode || !accountCodes.has(line.accountCode)) {
    errors.push({ field: `lines[${idx}].accountCode`, message: `unknown account code ${JSON.stringify(line.accountCode)}` });
  }
  if (!lineHasExactlyOneSide(line)) {
    errors.push({ field: `lines[${idx}]`, message: "each line must set exactly one of debit or credit (and to a non-zero amount)" });
  }
}

function parseEntryLines(raw: readonly unknown[], accountCodes: ReadonlySet<string>, errors: ValidationError[]): JournalLine[] {
  const lines: JournalLine[] = [];
  raw.forEach((rawLine, idx) => {
    const line = parseJournalLine(rawLine, idx, errors);
    if (line === null) return;
    validateEntryLine(line, idx, accountCodes, errors);
    lines.push(line);
  });
  return lines;
}

/** Report the debit = credit imbalance — but only when every line was
 *  readable. A line that failed to parse contributes nothing to the sum,
 *  so an entry that balances perfectly would otherwise be told it
 *  doesn't, sending the caller off to "fix" amounts that were never
 *  wrong. Naming the unreadable line is the actionable message; the
 *  balance is worth re-checking once it's a line. */
export function checkBalances(lines: readonly JournalLine[], expectedLineCount: number, subject: string, errors: ValidationError[]): void {
  if (lines.length !== expectedLineCount) return;
  const net = netBalance(lines);
  if (Math.abs(net) > EQUALITY_TOLERANCE) {
    errors.push({ field: "lines", message: `Σ debit − Σ credit = ${net.toFixed(4)}; ${subject} must balance` });
  }
}

function parseOptionalString(value: unknown, field: string, errors: ValidationError[]): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  errors.push({ field, message: `${field} must be a string when supplied` });
  return undefined;
}

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === "string";
const isOptionalNumber = (value: unknown): boolean => value === undefined || typeof value === "number";

function isJournalLine(value: unknown): value is JournalLine {
  return (
    hasStringProp(value, "accountCode") &&
    isOptionalNumber(value.debit) &&
    isOptionalNumber(value.credit) &&
    isOptionalString(value.memo) &&
    isOptionalString(value.taxRegistrationId)
  );
}

/** Checks every field `JournalEntry` and `JournalLine` declare, so a value
 *  that passes really is one. Used when reading the journal JSONL back:
 *  everything this module ever wrote satisfies it (`id` / `date` / `kind` /
 *  `lines` / `createdAt` have been required since the plugin's first
 *  release), while a line that doesn't is exactly the line that takes the
 *  whole book down — `report.ts` iterates `entry.lines` unguarded. */
export function isJournalEntry(value: unknown): value is JournalEntry {
  return (
    hasStringProp(value, "id") &&
    hasStringProp(value, "date") &&
    hasStringProp(value, "createdAt") &&
    JOURNAL_ENTRY_KINDS.some((kind) => kind === value.kind) &&
    isUnknownArray(value.lines) &&
    value.lines.every(isJournalLine) &&
    isOptionalString(value.memo) &&
    isOptionalString(value.voidedEntryId) &&
    isOptionalString(value.voidReason) &&
    isOptionalString(value.replacesEntryId)
  );
}

/** Normalize a journal line before persistence: trim string fields
 *  and drop empty-string optionals so the JSONL doesn't accumulate
 *  noise like `"taxRegistrationId":""`. Pure — does not mutate
 *  `line`. */
function normalizeLine(line: JournalLine): JournalLine {
  const out: JournalLine = { ...line };
  if (typeof out.taxRegistrationId === "string") {
    const trimmed = out.taxRegistrationId.trim();
    if (trimmed === "") delete out.taxRegistrationId;
    else out.taxRegistrationId = trimmed;
  }
  return out;
}

/** Parse one entry off the wire. Does not throw: every rejection comes
 *  back as a list of issues so the REST handler can return a structured
 *  400 instead of an opaque 500. Parse rather than validate — the
 *  narrowed entry rides along on success, so `makeEntry` never has to
 *  take the caller's word for the shape. */
export function parseEntry(raw: unknown, accounts: readonly Account[]): EntryParseResult {
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ field: "entry", message: "each entry must be an object with a date and a lines array" }] };
  }
  const errors: ValidationError[] = [];
  const date = typeof raw.date === "string" && isValidCalendarDate(raw.date) ? raw.date : null;
  if (date === null) errors.push({ field: "date", message: `expected YYYY-MM-DD calendar date, got ${JSON.stringify(raw.date)}` });
  if (!isUnknownArray(raw.lines) || raw.lines.length < 2) {
    errors.push({ field: "lines", message: "an entry needs at least two lines (one debit, one credit)" });
    return { ok: false, errors };
  }
  const lines = parseEntryLines(raw.lines, new Set(accounts.map((account) => account.code)), errors);
  checkBalances(lines, raw.lines.length, "entry", errors);
  const memo = parseOptionalString(raw.memo, "memo", errors);
  const replacesEntryId = parseOptionalString(raw.replacesEntryId, "replacesEntryId", errors);
  if (errors.length > 0 || date === null) return { ok: false, errors };
  return { ok: true, entry: { date, lines, memo, replacesEntryId } };
}

/** Build a JournalEntry from lines something already parsed
 *  (`parseEntry` / `parseOpening`). The id is a fresh
 *  UUID; createdAt is the wall clock at the moment of creation.
 *  Lines are normalized so optional string fields don't persist as
 *  empty strings. */
export function makeEntry(input: {
  date: string;
  lines: readonly JournalLine[];
  memo?: string | undefined;
  kind?: JournalEntry["kind"] | undefined;
  replacesEntryId?: string | undefined;
}): JournalEntry {
  const entry: JournalEntry = {
    id: randomUUID(),
    date: input.date,
    kind: input.kind ?? "normal",
    lines: input.lines.map(normalizeLine),
    memo: input.memo,
    createdAt: new Date().toISOString(),
  };
  if (input.replacesEntryId) entry.replacesEntryId = input.replacesEntryId;
  return entry;
}

/** Pick the most descriptive memo from the original entry to quote
 *  in the voiding entry's memo. Precedence: entry-level memo →
 *  first non-empty line memo → null (caller falls back to a
 *  date-only template). */
function originalMemoToQuote(target: JournalEntry): string | null {
  if (target.memo && target.memo.trim() !== "") return target.memo;
  for (const line of target.lines) {
    if (line.memo && line.memo.trim() !== "") return line.memo;
  }
  return null;
}

/** Build the human-readable memo that goes on the voiding entry.
 *  Format: `void of '<original memo>' on <original date>` (or the
 *  no-memo fallback when the original carried no memo). The reason
 *  the user typed is appended after a colon when present. */
export function voidMemo(target: JournalEntry, reason: string | undefined): string {
  const quoted = originalMemoToQuote(target);
  const base = quoted !== null ? `void of '${quoted}' on ${target.date}` : `void of entry on ${target.date}`;
  return reason && reason.trim() !== "" ? `${base}: ${reason}` : base;
}

/** Build the reversing pair for a voided entry. The `void` entry
 *  swaps debit / credit on every line so the net effect is zero;
 *  the `void-marker` is a zero-line entry that exists purely to
 *  carry the `voidedEntryId` reference and the user's reason. The
 *  marker keeps `listEntries` queries simple — filtering by
 *  `kind: "void-marker"` surfaces every voided id without scanning
 *  for matching pairs. */
export function makeVoidEntries(target: JournalEntry, reason: string | undefined, voidDate: string): { reverse: JournalEntry; marker: JournalEntry } {
  const swappedLines: JournalLine[] = target.lines.map((line) => {
    const swapped: JournalLine = {
      accountCode: line.accountCode,
      debit: line.credit,
      credit: line.debit,
      memo: line.memo,
    };
    // Preserve the counterparty tax-registration ID on each reversed
    // line so the audit trail survives the void — without it, the
    // reversing pair would silently drop the input-tax-credit
    // documentation and a later report scan couldn't reconstruct
    // which T-number / VAT ID the original input tax was tied to.
    if (line.taxRegistrationId !== undefined) swapped.taxRegistrationId = line.taxRegistrationId;
    return swapped;
  });
  const reverse: JournalEntry = {
    id: randomUUID(),
    date: voidDate,
    kind: "void",
    lines: swappedLines,
    memo: voidMemo(target, reason),
    voidedEntryId: target.id,
    voidReason: reason,
    createdAt: new Date().toISOString(),
  };
  const marker: JournalEntry = {
    id: randomUUID(),
    date: voidDate,
    kind: "void-marker",
    lines: [],
    voidedEntryId: target.id,
    voidReason: reason,
    createdAt: new Date().toISOString(),
  };
  return { reverse, marker };
}

/** Returns the set of entry ids that have been voided — built from
 *  every `void-marker` entry's `voidedEntryId`. Reports use this to
 *  exclude original-and-reverse pairs from the activity listing
 *  (the netting is automatic in B/S aggregates because the reverse
 *  entry has equal-and-opposite lines). */
export function voidedIdSet(entries: readonly JournalEntry[]): Set<string> {
  const set = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "void-marker" && entry.voidedEntryId) set.add(entry.voidedEntryId);
  }
  return set;
}
