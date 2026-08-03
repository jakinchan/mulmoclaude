/**
 * Lookup and Reference Functions
 */

import { functionRegistry, rawRangeReader, requiredArg, toNumber, parseCriteria, type FunctionHandler, type FunctionContext } from "../registry";
import { indexToColumn } from "../parser";
import { parseRangeBounds, resolveIndexTarget, resolveTableOffset } from "../formulaRefs";
import { isApproximateMatch } from "./lookup-math";
import type { CellValue } from "../types";
import { NA_ERROR, REF_ERROR } from "../spreadsheet-errors";

const inclusiveRange = (start: number, end: number): number[] => Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);

// Read a vertical slice (one column, `startRow`..`endRow`) as VLOOKUP's lookup column.
const columnValues = (context: FunctionContext, sheetPrefix: string, colStr: string, startRow: number, endRow: number): CellValue[] =>
  inclusiveRange(startRow, endRow).map((r) => context.getCellValue(`${sheetPrefix}${colStr}${r}`));

// Read a horizontal slice (one row, `startCol`..`endCol`) as HLOOKUP's lookup row.
const rowValues = (context: FunctionContext, sheetPrefix: string, row: number, startCol: number, endCol: number): CellValue[] =>
  inclusiveRange(startCol, endCol).map((c) => context.getCellValue(`${sheetPrefix}${indexToColumn(c)}${row}`));

/** The index of the LAST value that satisfies `matches`, or -1. Array.findIndex
 *  only walks forward, and XLOOKUP's `searchMode: -1` searches from the end. */
const findLastMatchIndex = (values: CellValue[], matches: (value: CellValue) => boolean): number =>
  values.reduce<number>((found, value, index) => (matches(value) ? index : found), -1);

/** The index of the last value in a SORTED list before `keepGoing` stops
 *  holding, or -1 when the very first value already fails. The list is assumed
 *  sorted (as Excel's approximate match requires), so the first failure ends the
 *  run. */
const lastIndexWhile = (values: CellValue[], keepGoing: (value: CellValue) => boolean): number => {
  const stop = values.findIndex((value) => !keepGoing(value));
  return (stop === -1 ? values.length : stop) - 1;
};

// Helper to find match index
const findMatchIndex = (
  lookupValue: CellValue,
  lookupArray: CellValue[],
  matchType: number = 1, // 1 = less than (sorted asc), 0 = exact, -1 = greater than (sorted desc)
  searchMode: number = 1, // 1 = first to last, -1 = last to first (for XLOOKUP)
): number => {
  const compare = (a: CellValue, b: CellValue) => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  };

  // Exact match
  if (matchType === 0) {
    // Handle wildcards for strings if it's an exact match request.
    // Loose equality otherwise, for "10" == 10.
    const usesWildcards = typeof lookupValue === "string" && (lookupValue.includes("*") || lookupValue.includes("?"));
    const isMatch = usesWildcards ? parseCriteria(lookupValue) : (item: CellValue) => item == lookupValue;
    return searchMode === 1 ? lookupArray.findIndex(isMatch) : findLastMatchIndex(lookupArray, isMatch);
  }

  // Approximate match (requires sorted array)
  // We'll assume the user knows what they are doing regarding sorting, as per Excel behavior

  // Less than or equal to, over an array sorted ascending: once we exceed, stop.
  if (matchType === 1) return lastIndexWhile(lookupArray, (item) => compare(item, lookupValue) <= 0);

  // Greater than or equal to, over an array sorted descending.
  if (matchType === -1) return lastIndexWhile(lookupArray, (item) => compare(item, lookupValue) >= 0);

  return -1;
};

const vlookupHandler: FunctionHandler = (args, context) => {
  const lookupValue = context.evaluateFormula(requiredArg(context, args, 0));
  const bounds = parseRangeBounds(requiredArg(context, args, 1));
  if (!bounds) throw new Error("Invalid table array range");
  const colIndexNum = toNumber(context.evaluateFormula(requiredArg(context, args, 2)));
  const rangeLookup = args.length === 4 ? context.evaluateFormula(requiredArg(context, args, 3)) : true;
  const matchType = isApproximateMatch(rangeLookup) ? 1 : 0;

  // Excel rejects a col_index_num past the table's width; reading on regardless
  // addressed a cell outside the range and usually returned a silent 0 (#2360).
  // Checked before the search: an out-of-range index is an argument error, so it
  // wins over the #N/A a missing key would otherwise mask it with (Codex review).
  const colOffset = resolveTableOffset(colIndexNum, bounds.endCol - bounds.startCol + 1);
  if (colOffset === null) return REF_ERROR;

  const startColStr = indexToColumn(bounds.startCol);
  const lookupArray = columnValues(context, bounds.sheetPrefix, startColStr, bounds.startRow, bounds.endRow);
  const matchIdx = findMatchIndex(lookupValue, lookupArray, matchType);
  if (matchIdx === -1) return NA_ERROR;

  const resultColStr = indexToColumn(bounds.startCol + colOffset);
  const resultRow = bounds.startRow + matchIdx;
  return context.getCellValue(`${bounds.sheetPrefix}${resultColStr}${resultRow}`);
};

const hlookupHandler: FunctionHandler = (args, context) => {
  const lookupValue = context.evaluateFormula(requiredArg(context, args, 0));
  const bounds = parseRangeBounds(requiredArg(context, args, 1));
  if (!bounds) throw new Error("Invalid range format");
  const rowIndexNum = toNumber(context.evaluateFormula(requiredArg(context, args, 2)));
  const rangeLookup = args.length === 4 ? context.evaluateFormula(requiredArg(context, args, 3)) : true;
  const matchType = isApproximateMatch(rangeLookup) ? 1 : 0;

  const rowOffset = resolveTableOffset(rowIndexNum, bounds.endRow - bounds.startRow + 1);
  if (rowOffset === null) return REF_ERROR;

  const lookupArray = rowValues(context, bounds.sheetPrefix, bounds.startRow, bounds.startCol, bounds.endCol);
  const matchIdx = findMatchIndex(lookupValue, lookupArray, matchType);
  if (matchIdx === -1) return NA_ERROR;

  const resultColStr = indexToColumn(bounds.startCol + matchIdx);
  const resultRow = bounds.startRow + rowOffset;
  return context.getCellValue(`${bounds.sheetPrefix}${resultColStr}${resultRow}`);
};

const matchHandler: FunctionHandler = (args, context) => {
  const lookupValue = context.evaluateFormula(requiredArg(context, args, 0));
  const lookupArrayRange = requiredArg(context, args, 1);
  const matchType = args.length === 3 ? toNumber(context.evaluateFormula(requiredArg(context, args, 2))) : 1;

  // Raw, not numeric-only: MATCH answers with a POSITION, so a dropped text
  // cell renumbers everything after it and returns a different row (#2765).
  const lookupArray = rawRangeReader(context)(lookupArrayRange);

  const index = findMatchIndex(lookupValue, lookupArray, matchType);

  return index === -1 ? NA_ERROR : index + 1; // 1-based index
};

const indexHandler: FunctionHandler = (args, context) => {
  const bounds = parseRangeBounds(requiredArg(context, args, 0));
  if (!bounds) throw new Error("Invalid range format");
  const rowNum = toNumber(context.evaluateFormula(requiredArg(context, args, 1)));
  const colNum = args.length >= 3 ? toNumber(context.evaluateFormula(requiredArg(context, args, 2))) : 1; // Default to 1 if omitted (for 1D arrays)

  const target = resolveIndexTarget(bounds, rowNum, colNum);
  if (!target) return REF_ERROR;
  return context.getCellValue(`${bounds.sheetPrefix}${indexToColumn(target.colIndex)}${target.row}`);
};

const xlookupHandler: FunctionHandler = (args, context) => {
  const lookupValue = context.evaluateFormula(requiredArg(context, args, 0));
  const lookupArrayRange = requiredArg(context, args, 1);
  const returnArrayRange = requiredArg(context, args, 2);
  const ifNotFound = args.length >= 4 ? context.evaluateFormula(requiredArg(context, args, 3)) : NA_ERROR;
  const matchMode = args.length >= 5 ? toNumber(context.evaluateFormula(requiredArg(context, args, 4))) : 0;
  const searchMode = args.length >= 6 ? toNumber(context.evaluateFormula(requiredArg(context, args, 5))) : 1;

  // Both raw, and for a second reason beyond MATCH's: the numeric-only reader
  // filters these two INDEPENDENTLY, so a text cell in one range shifts it
  // against the other and the match index reads a different row's value — a
  // wrong number with no error, which is the worst outcome a formula can have.
  const readRange = rawRangeReader(context);
  const lookupArray = readRange(lookupArrayRange);
  const returnArray = readRange(returnArrayRange);

  // XLOOKUP match modes:
  // 0 = Exact match (default)
  // -1 = Exact match or next smaller
  // 1 = Exact match or next larger
  // 2 = Wildcard match

  // Map XLOOKUP modes to our internal findMatchIndex modes
  // Our internal: 0=exact, 1=less than (sorted), -1=greater than (sorted)
  // XLOOKUP is more complex because it doesn't require sorted arrays for next smaller/larger
  // For now, we'll implement exact (0) and wildcard (2 -> handled by exact with wildcard logic in findMatchIndex)
  // For -1 and 1, we'll do a linear search for best match if not sorted

  let matchIdx = -1;

  if (matchMode === 0 || matchMode === 2) {
    matchIdx = findMatchIndex(lookupValue, lookupArray, 0, searchMode);
  } else {
    // Implement exact or next smaller/larger for unsorted arrays
    // This is O(N)
    let bestDiff = Infinity;

    for (let i = 0; i < lookupArray.length; i++) {
      const idx = searchMode === 1 ? i : lookupArray.length - 1 - i;
      const item = lookupArray[idx];

      if (item == lookupValue) {
        matchIdx = idx;
        break;
      }

      if (typeof item === "number" && typeof lookupValue === "number") {
        const diff = item - lookupValue;
        if (matchMode === -1 && diff < 0 && Math.abs(diff) < bestDiff) {
          // Next smaller (closest negative difference)
          bestDiff = Math.abs(diff);
          matchIdx = idx;
        } else if (matchMode === 1 && diff > 0 && diff < bestDiff) {
          // Next larger (closest positive difference)
          bestDiff = diff;
          matchIdx = idx;
        }
      }
    }
  }

  if (matchIdx === -1) return ifNotFound;

  // A match past the end of the return range has nothing to return — the two
  // ranges are independent arguments and need not be the same length.
  const found = returnArray[matchIdx];
  return found === undefined ? NA_ERROR : found;
};

// Register functions
functionRegistry.register({
  name: "VLOOKUP",
  handler: vlookupHandler,
  minArgs: 3,
  maxArgs: 4,
  description: "Looks for a value in the leftmost column of a table, and then returns a value in the same row from a column you specify",
  examples: ["VLOOKUP(105, A2:C10, 2)", 'VLOOKUP("Smith", A2:E10, 5, FALSE)'],
  category: "Lookup & Reference",
});

functionRegistry.register({
  name: "HLOOKUP",
  handler: hlookupHandler,
  minArgs: 3,
  maxArgs: 4,
  description: "Looks for a value in the top row of a table, and then returns a value in the same column from a row you specify",
  examples: ['HLOOKUP("Axles", A1:C10, 2, TRUE)'],
  category: "Lookup & Reference",
});

functionRegistry.register({
  name: "MATCH",
  handler: matchHandler,
  minArgs: 2,
  maxArgs: 3,
  description: "Returns the relative position of an item in an array that matches a specified value",
  examples: ["MATCH(25, A1:A10, 0)", 'MATCH("b", A1:A5, 0)'],
  category: "Lookup & Reference",
});

functionRegistry.register({
  name: "INDEX",
  handler: indexHandler,
  minArgs: 2,
  maxArgs: 4,
  description: "Returns the value of an element in a table or an array, selected by the row and column number indexes",
  examples: ["INDEX(A1:B5, 2, 2)", "INDEX(A1:A10, 5)"],
  category: "Lookup & Reference",
});

functionRegistry.register({
  name: "XLOOKUP",
  handler: xlookupHandler,
  minArgs: 3,
  maxArgs: 6,
  description: "Searches a range or an array, and returns an item corresponding to the first match it finds",
  examples: ["XLOOKUP(A1, B1:B10, C1:C10)", 'XLOOKUP("USA", Countries, Populations)'],
  category: "Lookup & Reference",
});
