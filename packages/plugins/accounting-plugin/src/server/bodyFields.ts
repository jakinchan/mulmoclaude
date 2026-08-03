// Readers for the loosely-typed dispatch body, and for the service
// payloads the message builders narrate back.
//
// Everything below the `action` discriminator arrives as `unknown` off
// the wire, so a field is only a string once something has checked. A
// non-string reads as absent, which lets the service layer reject it on
// its own terms — `bookId: 42` gets "bookId is required" instead of
// being smuggled through as a string the rest of the stack believes in.

import { isRecord } from "@mulmoclaude/common";

import type { ReportPeriod } from "../shared/types.js";

export const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export const optionalRecord = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_MONTH_DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** `YYYY-MM-DD` that names a day the calendar actually has. The regex alone
 *  admits `2026-02-30`, and `Date.UTC` rolls that forward to March instead of
 *  refusing it, so the round trip is what says the date is real. */
const isCalendarDate = (value: string): boolean => {
  if (!YEAR_MONTH_DAY_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
};

/** Rebuilt field by field rather than narrowed with a predicate, so the
 *  returned object is one this function actually proved. A half-formed
 *  `{ kind: "month" }` reads as absent and the caller raises its own
 *  "period is required" — previously it reached the report builders and
 *  produced an `undefined-01` date.
 *
 *  The FORMAT is checked here too, not just the type: `typeof === "string"`
 *  let `{ kind: "month", period: "banana" }` through, which came back as a
 *  balance sheet dated `"banana-NaN"` and made the snapshot cache write
 *  `banana.json` / `0NaN-NaN.json` into the book (#2765). Malformed reads as
 *  absent so it lands on the caller's existing 400, which already spells out
 *  both accepted shapes for the LLM to repair its payload from. */
export const optionalReportPeriod = (value: unknown): ReportPeriod | undefined => {
  const period = optionalRecord(value);
  if (period?.kind === "month" && typeof period.period === "string" && YEAR_MONTH_RE.test(period.period)) {
    return { kind: "month", period: period.period };
  }
  if (
    period?.kind === "range" &&
    typeof period.from === "string" &&
    typeof period.to === "string" &&
    isCalendarDate(period.from) &&
    isCalendarDate(period.to)
  ) {
    return { kind: "range", from: period.from, to: period.to };
  }
  return undefined;
};

/** The two fields the addEntries narration quotes back, read out of a
 *  service payload that is only `unknown` to the router. */
export const describeEntry = (entry: unknown): { id?: string; date?: string } => {
  const record = optionalRecord(entry);
  return { id: optionalString(record?.id), date: optionalString(record?.date) };
};
