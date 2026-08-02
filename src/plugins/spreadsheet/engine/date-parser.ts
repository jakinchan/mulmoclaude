/**
 * Date Parsing Utilities
 *
 * Parse various date string formats into Excel serial numbers.
 */

import { dateToSerial, MONTH_NAMES_SHORT, MONTH_NAMES_FULL } from "./date-utils";

/**
 * Check if a string looks like a date
 *
 * @param str - String to check
 * @returns true if string matches common date patterns
 */
export function isDateLike(str: string): boolean {
  if (typeof str !== "string") return false;
  if (str.length < 6 || str.length > 30) return false; // Reasonable length for dates

  // Common date patterns:
  // MM/DD/YYYY, DD/MM/YYYY, M/D/YYYY
  // YYYY-MM-DD, YYYY/MM/DD
  // DD-MMM-YYYY, D-MMM-YYYY
  // MMM D, YYYY, MMMM D, YYYY

  // Pattern 1: Contains digits and separators (/, -, space)
  const hasDigits = /\d/.test(str);
  const hasSeparator = /[/\-\s,]/.test(str);

  if (!hasDigits || !hasSeparator) return false;

  // Pattern 2: Matches common date formats
  const datePatterns = [
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/, // MM/DD/YYYY or DD/MM/YYYY
    /^\d{4}-\d{1,2}-\d{1,2}$/, // YYYY-MM-DD
    /^\d{4}\/\d{1,2}\/\d{1,2}$/, // YYYY/MM/DD
    /^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/, // DD-MMM-YYYY
    /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/, // MMM D, YYYY or MMMM D, YYYY
    /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/, // D MMM YYYY
  ];

  return datePatterns.some((pattern) => pattern.test(str.trim()));
}

/**
 * Build the Excel serial number for a year/month/day triple, or null when the
 * triple is not a valid calendar date. Every dated branch of `parseDate` ends in
 * this same validate → Date.UTC → dateToSerial step.
 */
export function serialFromParts(year: number, month: number, day: number): number | null {
  if (!isValidDate(year, month, day)) return null;
  return dateToSerial(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * The three capture groups of a date pattern, as a tuple the caller can
 * destructure. `null` when the text does not match — or when a group did not
 * participate, which every pattern here makes impossible, so it lands on the
 * same "not a date" answer rather than reading an absent group as text.
 */
function matchDateParts(text: string, pattern: RegExp): [string, string, string] | null {
  const [, first, second, third] = text.match(pattern) ?? [];
  if (first === undefined || second === undefined || third === undefined) return null;
  return [first, second, third];
}

const SLASH_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;
const MAX_MONTH = 12;

/** Whether `A/B/YYYY` reads day-first. A number no month can hold decides on its
 *  own; an ambiguous pair follows the reading preference. Shared with
 *  `getDefaultDateFormat` so a slash date renders in the order it was READ. */
const readsDayFirst = (first: number, second: number, preferDDMMYYYY: boolean): boolean =>
  first > MAX_MONTH || (second <= MAX_MONTH && first <= MAX_MONTH && preferDDMMYYYY);

/**
 * Parse a month name to month number (1-12)
 */
function parseMonthName(monthStr: string): number | null {
  const month = monthStr.toLowerCase();

  // Try short names
  const shortIndex = MONTH_NAMES_SHORT.findIndex((m) => m.toLowerCase() === month);
  if (shortIndex !== -1) return shortIndex + 1;

  // Try full names
  const fullIndex = MONTH_NAMES_FULL.findIndex((m) => m.toLowerCase() === month);
  if (fullIndex !== -1) return fullIndex + 1;

  return null;
}

/**
 * Parse a date string into Excel serial number
 *
 * Supports formats:
 * - MM/DD/YYYY, M/D/YYYY
 * - DD/MM/YYYY (when day > 12)
 * - YYYY-MM-DD, YYYY/MM/DD (ISO format)
 * - DD-MMM-YYYY, D-MMM-YYYY
 * - MMM D, YYYY, MMMM D, YYYY
 *
 * @param dateStr - String that might contain a date
 * @param preferDDMMYYYY - Prefer DD/MM/YYYY over MM/DD/YYYY for ambiguous dates (default: false)
 * @returns Serial number or null if not a valid date
 */
export function parseDate(dateStr: string, preferDDMMYYYY: boolean = false): number | null {
  if (!isDateLike(dateStr)) return null;

  const trimmed = dateStr.trim();

  // Try YYYY-MM-DD or YYYY/MM/DD (ISO format)
  const isoParts = matchDateParts(trimmed, /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoParts) {
    const [year, month, day] = isoParts;
    return serialFromParts(parseInt(year), parseInt(month), parseInt(day));
  }

  // Try DD-MMM-YYYY or D-MMM-YYYY
  const dmmyParts = matchDateParts(trimmed, /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (dmmyParts) {
    const [day, monthName, year] = dmmyParts;
    return serialFromNamedMonth(expandTwoDigitYear(parseInt(year)), monthName, parseInt(day));
  }

  // Try MMM D, YYYY or MMMM D, YYYY
  const mmmParts = matchDateParts(trimmed, /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mmmParts) {
    const [monthName, day, year] = mmmParts;
    return serialFromNamedMonth(parseInt(year), monthName, parseInt(day));
  }

  // Try D MMM YYYY
  const dMmmParts = matchDateParts(trimmed, /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (dMmmParts) {
    const [day, monthName, year] = dMmmParts;
    return serialFromNamedMonth(parseInt(year), monthName, parseInt(day));
  }

  // Try MM/DD/YYYY or DD/MM/YYYY
  const slashParts = matchDateParts(trimmed, SLASH_DATE_PATTERN);
  if (slashParts) {
    const [first, second, year] = slashParts;
    // If first > 12, it must be DD/MM; if second > 12, it must be MM/DD.
    // Otherwise use preference (default to MM/DD for US format).
    const dayFirst = readsDayFirst(parseInt(first), parseInt(second), preferDDMMYYYY);
    const month = dayFirst ? parseInt(second) : parseInt(first);
    const day = dayFirst ? parseInt(first) : parseInt(second);
    return serialFromParts(expandTwoDigitYear(parseInt(year)), month, day);
  }

  return null;
}

/** A two-digit year reads as this century up to 29, the previous one after. */
const TWO_DIGIT_YEAR_LIMIT = 100;
const CENTURY_PIVOT = 30;

function expandTwoDigitYear(year: number): number {
  if (year >= TWO_DIGIT_YEAR_LIMIT) return year;
  return year < CENTURY_PIVOT ? 2000 + year : 1900 + year;
}

function serialFromNamedMonth(year: number, monthName: string, day: number): number | null {
  const month = parseMonthName(monthName);
  if (month === null) return null;
  return serialFromParts(year, month, day);
}

/**
 * Validate that a date is valid
 */
function isValidDate(year: number, month: number, day: number): boolean {
  // Check basic ranges
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  // Check if day is valid for the given month
  const date = new Date(Date.UTC(year, month - 1, day));

  // If the date rolls over to the next month, it's invalid
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Get default date format based on parsed date
 *
 * @param originalStr - Original date string
 * @returns Appropriate format code
 */
export function getDefaultDateFormat(originalStr: string, preferDDMMYYYY: boolean = false): string {
  const trimmed = originalStr.trim();

  // YYYY-MM-DD → use same format
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) {
    return "YYYY-MM-DD";
  }

  // YYYY/MM/DD parses as ISO, so it must keep a year-first label. Without this
  // branch it fell through to the slash default and re-rendered as MM/DD or
  // DD/MM — the same digits in a different order, which reads as a different
  // date (Codex review).
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(trimmed)) {
    return "YYYY/MM/DD";
  }

  // DD-MMM-YYYY → use same format
  if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(trimmed)) {
    return "DD-MMM-YYYY";
  }

  // MMM D, YYYY → use same format
  if (/^[A-Za-z]{3}\s+\d{1,2},?\s+\d{4}$/.test(trimmed)) {
    return "MMM D, YYYY";
  }

  // MMMM D, YYYY → use same format
  if (/^[A-Za-z]{4,9}\s+\d{1,2},?\s+\d{4}$/.test(trimmed)) {
    return "MMMM D, YYYY";
  }

  // A slash date must render in the order it was READ, or the cell shows the
  // user's own input with its two halves swapped. `parseDate` takes the first
  // number as the day whenever it cannot be a month, whatever the preference
  // says, so that case is decided here the same way.
  const slashParts = matchDateParts(trimmed, SLASH_DATE_PATTERN);
  if (slashParts) {
    const [first, second] = slashParts;
    return readsDayFirst(parseInt(first), parseInt(second), preferDDMMYYYY) ? "DD/MM/YYYY" : "MM/DD/YYYY";
  }

  // Anything unrecognised keeps the reading order's default.
  return preferDDMMYYYY ? "DD/MM/YYYY" : "MM/DD/YYYY";
}
