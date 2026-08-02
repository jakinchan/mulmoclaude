/**
 * Statistical Functions
 */

import { functionRegistry, requiredArg, toNumber, parseCriteria, type FunctionContext, type FunctionHandler, type RangeGetter } from "../registry";
import { computeAverage, computeMedian, computeMode, sampleStdev, sampleVariance } from "./statistical-math";
import { DIV_ZERO_ERROR } from "../spreadsheet-errors";
import { holdsNumber } from "../numericCoercion";
import type { CellValue } from "../types";

// Excel accepts up to 255 arguments for its aggregate functions.
const MAX_AGGREGATE_ARGS = 255;

// `A1`, `$A$1`, `AA100`: column letters then row digits, each half optionally
// prefixed by `$`.
const CELL_REFERENCE_PATTERN = /^\$?[A-Z]+\$?\d+$/i;

const isCellReference = (segment: string): boolean => CELL_REFERENCE_PATTERN.test(segment);

// Everything after the last `!` — the reference without its sheet name, or the
// whole string when it carries none.
const withoutSheetPrefix = (value: string): string => value.slice(value.lastIndexOf("!") + 1);

const isRangeReference = (value: string): boolean => {
  if (!value) return false;
  const [start, end] = withoutSheetPrefix(value).split(":");
  if (!start || !end) return false;
  return isCellReference(start) && isCellReference(end);
};

// A bare cell reference (`A1`, `Sheet1!B2`) is read through the RANGE path, not
// evaluated as a scalar: the scalar path coerces a blank or text cell to 0, so
// COUNT(A999) counted an empty cell as a value. The range path yields nothing
// for a cell that holds nothing, which is what the count functions need.
const isReference = (arg: string): boolean => isRangeReference(arg) || isCellReference(withoutSheetPrefix(arg));

/** One value an argument contributed, tagged by where it came from. A range cell
 *  was already filtered by the range getter; a scalar is whatever the argument
 *  evaluated to and may hold no number at all. */
type ArgumentValue = { value: CellValue; isScalar: boolean };

const collectArgumentValues = (args: string[], context: FunctionContext, readRange: RangeGetter): ArgumentValue[] => {
  const collected: ArgumentValue[] = [];

  for (const rawArg of args) {
    const arg = rawArg?.trim();
    if (!arg) continue;

    if (isReference(arg)) {
      readRange(arg).forEach((value) => collected.push({ value, isScalar: false }));
    } else {
      collected.push({ value: context.evaluateFormula(arg), isScalar: true });
    }
  }

  return collected;
};

const rawRangeReader = (context: FunctionContext): RangeGetter => context.getRangeValuesRaw ?? context.getRangeValues;

const collectNumericValues = (args: string[], context: FunctionContext): number[] =>
  collectArgumentValues(args, context, context.getRangeValues).map(({ value }) => toNumber(value));

// Same walk as `collectNumericValues`, but keeping each cell as it is: COUNTA
// counts non-empty cells, so text must survive the trip.
const collectRawValues = (args: string[], context: FunctionContext): CellValue[] =>
  collectArgumentValues(args, context, rawRangeReader(context)).map(({ value }) => value);

const sumHandler: FunctionHandler = (args, context) => {
  const values = collectNumericValues(args, context);
  return values.reduce((sum: number, value) => sum + value, 0);
};

// Multi-argument collection (#2360) feeding the empty-range error rule (#2501).
const averageHandler: FunctionHandler = (args, context) => computeAverage(collectNumericValues(args, context));

const maxHandler: FunctionHandler = (args, context) => {
  const values = collectNumericValues(args, context);
  return values.length > 0 ? Math.max(...values) : 0;
};

const minHandler: FunctionHandler = (args, context) => {
  const values = collectNumericValues(args, context);
  return values.length > 0 ? Math.min(...values) : 0;
};

// COUNT counts NUMBERS, so it cannot go through the lenient numeric collection
// the other aggregates share: `toNumber("text")` is 0, which made COUNT("text")
// answer 1 where Excel answers 0 (Codex review). A range cell reached the list
// only by being numeric already; a scalar has to be asked.
const countsAsNumber = ({ value, isScalar }: ArgumentValue): boolean => !isScalar || holdsNumber(value);

const countHandler: FunctionHandler = (args, context) => collectArgumentValues(args, context, context.getRangeValues).filter(countsAsNumber).length;

const medianHandler: FunctionHandler = (args, context) => computeMedian(collectNumericValues(args, context));

const modeHandler: FunctionHandler = (args, context) => {
  return computeMode(collectNumericValues(args, context));
};

const stdevHandler: FunctionHandler = (args, context) => {
  return sampleStdev(collectNumericValues(args, context));
};

const varHandler: FunctionHandler = (args, context) => {
  return sampleVariance(collectNumericValues(args, context));
};

const countaHandler: FunctionHandler = (args, context) => {
  const values = collectRawValues(args, context);
  // Count non-empty cells
  return values.filter((value) => value !== null && value !== undefined && value !== "").length;
};

const countifHandler: FunctionHandler = (args, context) => {
  const values = rawRangeReader(context)(requiredArg(context, args, 0));
  return values.filter(parseCriteria(requiredArg(context, args, 1).trim())).length;
};

/** The criteria range, the matcher and the value range SUMIF and AVERAGEIF both
 *  read. Both value ranges are RAW, not numeric-only: dropping blanks would
 *  shift the value range out of alignment with the (raw) criteria range, so a
 *  blank would pull a later row's number into an earlier match (#2358). */
const readConditionalRanges = (args: string[], context: FunctionContext) => {
  const criteriaRef = requiredArg(context, args, 0);
  const readRaw = rawRangeReader(context);
  const valueRef = args.length === 3 ? requiredArg(context, args, 2) : criteriaRef;
  return {
    criteriaRange: readRaw(criteriaRef),
    valueRange: readRaw(valueRef),
    matches: parseCriteria(requiredArg(context, args, 1).trim()),
  };
};

/** Sum and count the values whose row in `criteriaRange` matches. The two
 *  ranges stay row-aligned, so a matched row with no value contributes 0. */
const aggregateMatchedRows = (criteriaRange: CellValue[], valueRange: CellValue[], matches: (value: CellValue) => boolean) =>
  criteriaRange.reduce(
    (totals, criteriaValue, index) => (matches(criteriaValue) ? { sum: totals.sum + toNumber(valueRange[index] ?? 0), count: totals.count + 1 } : totals),
    { sum: 0, count: 0 },
  );

const sumifHandler: FunctionHandler = (args, context) => {
  const { criteriaRange, valueRange, matches } = readConditionalRanges(args, context);
  return aggregateMatchedRows(criteriaRange, valueRange, matches).sum;
};

const averageifHandler: FunctionHandler = (args, context) => {
  const { criteriaRange, valueRange, matches } = readConditionalRanges(args, context);
  const { sum, count } = aggregateMatchedRows(criteriaRange, valueRange, matches);
  // Excel returns #DIV/0! when no cell matches (the average of nothing is
  // undefined), rather than a silent 0.
  return count > 0 ? sum / count : DIV_ZERO_ERROR;
};

// Register all statistical functions
functionRegistry.register({
  name: "SUM",
  handler: sumHandler,
  minArgs: 1,
  maxArgs: MAX_AGGREGATE_ARGS,
  description: "Returns the sum of all numbers in a range",
  examples: ["SUM(A1:A10)", "SUM(B2:B20)"],
  category: "Statistical",
});

functionRegistry.register({
  name: "AVERAGE",
  handler: averageHandler,
  minArgs: 1,
  maxArgs: MAX_AGGREGATE_ARGS,
  description: "Returns the average (arithmetic mean) of numbers in a range",
  examples: ["AVERAGE(A1:A10)", "AVERAGE(B2:B20)"],
  category: "Statistical",
});

functionRegistry.register({
  name: "MAX",
  handler: maxHandler,
  minArgs: 1,
  description: "Returns the largest value in a range",
  examples: ["MAX(A1:A10)", "MAX(B2:B20)"],
  category: "Statistical",
});

functionRegistry.register({
  name: "MIN",
  handler: minHandler,
  minArgs: 1,
  description: "Returns the smallest value in a range",
  examples: ["MIN(A1:A10)", "MIN(B2:B20)"],
  category: "Statistical",
});

functionRegistry.register({
  name: "COUNT",
  handler: countHandler,
  minArgs: 1,
  maxArgs: MAX_AGGREGATE_ARGS,
  description: "Counts the number of cells in a range",
  examples: ["COUNT(A1:A10)", "COUNT(B2:B20)"],
  category: "Statistical",
});

functionRegistry.register({
  name: "MEDIAN",
  handler: medianHandler,
  minArgs: 1,
  maxArgs: MAX_AGGREGATE_ARGS,
  description: "Returns the median (middle) value in a range",
  examples: ["MEDIAN(A1:A10)", "MEDIAN(B2:B20)"],
  category: "Statistical",
});

functionRegistry.register({
  name: "MODE",
  handler: modeHandler,
  minArgs: 1,
  maxArgs: MAX_AGGREGATE_ARGS,
  description: "Returns the most frequently occurring value in a range",
  examples: ["MODE(A1:A10)", "MODE(B2:B20)"],
  category: "Statistical",
});

functionRegistry.register({
  name: "STDEV",
  handler: stdevHandler,
  minArgs: 1,
  maxArgs: MAX_AGGREGATE_ARGS,
  description: "Returns the standard deviation of numbers in a range",
  examples: ["STDEV(A1:A10)", "STDEV(B2:B20)"],
  category: "Statistical",
});

functionRegistry.register({
  name: "VAR",
  handler: varHandler,
  minArgs: 1,
  maxArgs: MAX_AGGREGATE_ARGS,
  description: "Returns the variance of numbers in a range",
  examples: ["VAR(A1:A10)", "VAR(B2:B20)"],
  category: "Statistical",
});

functionRegistry.register({
  name: "COUNTA",
  handler: countaHandler,
  minArgs: 1,
  maxArgs: MAX_AGGREGATE_ARGS,
  description: "Counts the number of non-empty cells in a range",
  examples: ["COUNTA(A1:A10)", "COUNTA(B2:B20)"],
  category: "Statistical",
});

functionRegistry.register({
  name: "COUNTIF",
  handler: countifHandler,
  minArgs: 2,
  maxArgs: 2,
  description: "Counts cells in a range that match a criteria",
  examples: ['COUNTIF(A1:A10, ">5")', 'COUNTIF(B1:B10, "Yes")'],
  category: "Statistical",
});

functionRegistry.register({
  name: "SUMIF",
  handler: sumifHandler,
  minArgs: 2,
  maxArgs: 3,
  description: "Sums cells in a range that match a criteria",
  examples: ['SUMIF(A1:A10, ">5")', 'SUMIF(A1:A10, ">5", B1:B10)'],
  category: "Statistical",
});

functionRegistry.register({
  name: "AVERAGEIF",
  handler: averageifHandler,
  minArgs: 2,
  maxArgs: 3,
  description: "Averages cells in a range that match a criteria",
  examples: ['AVERAGEIF(A1:A10, ">5")', 'AVERAGEIF(A1:A10, ">5", B1:B10)'],
  category: "Statistical",
});
