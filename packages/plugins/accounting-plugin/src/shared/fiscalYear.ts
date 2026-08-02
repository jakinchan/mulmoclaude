// Fiscal-year arithmetic for the accounting plugin.
//
// Each book stores a `fiscalYearEnd` = the calendar month (1-12) on
// whose LAST DAY the book's fiscal year closes:
//
//   3  → fiscal year ends March 31     (FY runs Apr 1 → Mar 31)
//   6  → fiscal year ends June 30      (FY runs Jul 1 → Jun 30)
//   8  → fiscal year ends August 31    (FY runs Sep 1 → Aug 31)
//   12 → fiscal year ends December 31  (FY runs Jan 1 → Dec 31; default)
//
// Any month is allowed — a corporation whose statutory closing date
// is August 31 stores 8. The quarter / year arithmetic below is fully
// parametric on the closing month, so a non-calendar-quarter close
// (e.g. 8) just shifts the fiscal quarters accordingly.
//
// "Current quarter" / "current year" everywhere in the UI refer to
// the *fiscal* quarter / *fiscal* year that contains today, under the
// active book's `fiscalYearEnd`. For a December (12) book fiscal
// quarters and fiscal years coincide with calendar quarters / calendar
// years; for any other close a shift applies.
//
// Legacy books (written when the field was a calendar-quarter token
// "Q1".."Q4") are absorbed by `resolveFiscalYearEnd`, which maps the
// old tokens to their closing month (Q1→3, Q2→6, Q3→9, Q4→12). The
// on-disk value is only rewritten the next time the user saves the
// book — same no-auto-migrate policy the field has always had.
//
// All helpers return `YYYY-MM-DD` strings in the user's local
// timezone — same convention as `dates.ts`.

export const FISCAL_YEAR_END_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type FiscalYearEnd = (typeof FISCAL_YEAR_END_MONTHS)[number];

export const DEFAULT_FISCAL_YEAR_END: FiscalYearEnd = 12;

/** Legacy calendar-quarter tokens → closing month, for books written
 *  before the field became a month number. */
// A Map rather than a plain record: the key is caller-supplied, and a
// record lookup would resolve inherited prototype members ("constructor")
// as if they were stored quarters.
const LEGACY_QUARTER_MONTHS = new Map<string, FiscalYearEnd>([
  ["Q1", 3],
  ["Q2", 6],
  ["Q3", 9],
  ["Q4", 12],
]);

export function isFiscalYearEnd(value: unknown): value is FiscalYearEnd {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12;
}

/** Normalise any stored / inbound value to a concrete closing month.
 *  Absent or unrecognised → the default (December); a legacy "Q1".."Q4"
 *  token → its closing month; a valid 1-12 number → itself. Kept
 *  tolerant (unknown input) so a legacy book read from disk — or shared
 *  with an older MulmoTerminal — never breaks the UI or a report. */
export function resolveFiscalYearEnd(value: unknown): FiscalYearEnd {
  if (isFiscalYearEnd(value)) return value;
  const legacy = typeof value === "string" ? LEGACY_QUARTER_MONTHS.get(value) : undefined;
  return legacy ?? DEFAULT_FISCAL_YEAR_END;
}

/** Last calendar month (1-12) of the fiscal year. The stored token IS
 *  the closing month now, so this reads as `resolveFiscalYearEnd` under
 *  a name that states intent at the call sites (and still absorbs a
 *  stray legacy token defensively). */
export function fiscalYearEndMonth(end: FiscalYearEnd): number {
  return resolveFiscalYearEnd(end);
}

/** Localised label for a fiscal-year-end month, showing that month's
 *  last day — e.g. 8 → "August 31" / "8月31日" / "31 de agosto". Uses a
 *  fixed non-leap reference year, so February reads as the 28th; this
 *  is display only — the engine still computes the real last day
 *  (Feb 29 in a leap year) at runtime. */
export function fiscalYearEndMonthLabel(month: FiscalYearEnd, locale: string): string {
  // UTC day 0 of the *next* month = last day of `month`, in a fixed
  // non-leap reference year (2001) so the label is stable and
  // timezone-independent.
  const lastDay = new Date(Date.UTC(2001, month, 0));
  try {
    return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", timeZone: "UTC" }).format(lastDay);
  } catch {
    return String(month);
  }
}

export interface DateRange {
  /** Inclusive lower bound (YYYY-MM-DD). Empty string = unbounded. */
  from: string;
  /** Inclusive upper bound (YYYY-MM-DD). Empty string = unbounded. */
  to: string;
}

function pad2(num: number): string {
  return String(num).padStart(2, "0");
}

function lastDayOfMonth(year: number, monthZeroBased: number): number {
  // Day 0 of next month = last day of this month, all in local time.
  return new Date(year, monthZeroBased + 1, 0).getDate();
}

function ymd(year: number, monthOneBased: number, day: number): string {
  return `${year}-${pad2(monthOneBased)}-${pad2(day)}`;
}

/** Fiscal quarter index (0..3) of the given local date under `end`,
 *  where 0 is the first quarter of the fiscal year (right after the
 *  prior year's close) and 3 is the closing quarter. */
function fiscalQuarterIndex(end: FiscalYearEnd, today: Date): number {
  const closingMonth = fiscalYearEndMonth(end); // 1-based
  const month = today.getMonth() + 1; // 1-based local month
  // Months past the close of the prior fiscal year, mod 12.
  const offset = (month - closingMonth - 1 + 12) % 12;
  return Math.floor(offset / 3);
}

/** Calendar (year, monthOneBased) of the *first* month of the fiscal
 *  quarter at index `index` in the fiscal year that *contains*
 *  `today`. Returned both as the first day of that month and as the
 *  count of months covered (always 3 — exposed as a constant). */
function fiscalQuarterStart(end: FiscalYearEnd, today: Date, index: number): { year: number; month: number } {
  const closingMonth = fiscalYearEndMonth(end);
  const todayMonth = today.getMonth() + 1;
  const todayYear = today.getFullYear();
  // Month after the close of the prior fiscal year — fiscal-year start month.
  const startMonth = (closingMonth % 12) + 1;
  // The fiscal year that contains `today` started in the calendar
  // year ≤ today's year. Specifically: if today's calendar month is
  // ≥ startMonth (or startMonth is 1, which is the Q4 case), the FY
  // started this calendar year; otherwise it started last year.
  const fyStartYear = todayMonth >= startMonth ? todayYear : todayYear - 1;
  // Month of the requested fiscal quarter's first month, expressed
  // as a 1-based offset from January of fyStartYear.
  const flatMonth = startMonth + index * 3; // 1-based, may exceed 12
  const year = fyStartYear + Math.floor((flatMonth - 1) / 12);
  const month = ((flatMonth - 1) % 12) + 1;
  return { year, month };
}

function quarterRangeAt(end: FiscalYearEnd, today: Date, index: number): DateRange {
  const start = fiscalQuarterStart(end, today, index);
  // Quarter spans 3 calendar months starting at `start`.
  const lastMonthFlat = start.month - 1 + 2; // 0-based offset of the third month
  const lastMonthYear = start.year + Math.floor(lastMonthFlat / 12);
  const lastMonth = (lastMonthFlat % 12) + 1; // 1-based
  const lastDay = lastDayOfMonth(lastMonthYear, lastMonth - 1);
  return {
    from: ymd(start.year, start.month, 1),
    to: ymd(lastMonthYear, lastMonth, lastDay),
  };
}

export function currentQuarterRange(end: FiscalYearEnd, today: Date = new Date()): DateRange {
  return quarterRangeAt(end, today, fiscalQuarterIndex(end, today));
}

export function previousQuarterRange(end: FiscalYearEnd, today: Date = new Date()): DateRange {
  const idx = fiscalQuarterIndex(end, today);
  if (idx > 0) return quarterRangeAt(end, today, idx - 1);
  // Wrap to Q4 of the prior fiscal year. Step `today` back 3 months
  // — that lands inside the prior fiscal year regardless of `end`,
  // and Q4 (closing) is index 3 within whichever FY contains it.
  const stepped = new Date(today.getFullYear(), today.getMonth() - 3, 1);
  return quarterRangeAt(end, stepped, 3);
}

/** Current fiscal year — Q0 start through Q3 close. */
export function currentFiscalYearRange(end: FiscalYearEnd, today: Date = new Date()): DateRange {
  const first = quarterRangeAt(end, today, 0);
  const last = quarterRangeAt(end, today, 3);
  return { from: first.from, to: last.to };
}

export function previousFiscalYearRange(end: FiscalYearEnd, today: Date = new Date()): DateRange {
  // Step a year back so `quarterRangeAt` resolves the prior FY.
  const stepped = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  return currentFiscalYearRange(end, stepped);
}
