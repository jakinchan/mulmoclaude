/**
 * Financial Functions
 */

import { functionRegistry, requiredArg, toNumber, type FunctionContext, type FunctionHandler } from "../registry";
import { computeFv, computePmt, computeIpmt, computePpmt, computePv, computeNper, computeRate, computeNpv, computeIrr } from "../financial-math";

/**
 * FV - Future Value
 * Calculates the future value of an investment based on periodic, constant payments and a constant interest rate.
 * FV(rate, nper, pmt, [pv], [type])
 * - rate: Interest rate per period
 * - nper: Total number of payment periods
 * - pmt: Payment made each period (negative for outflows)
 * - pv: Present value (optional, default 0)
 * - type: 0 = end of period, 1 = beginning of period (optional, default 0)
 */
const fvHandler: FunctionHandler = (args, context) => {
  const rate = toNumber(context.evaluateFormula(requiredArg(context, args, 0)));
  const nper = toNumber(context.evaluateFormula(requiredArg(context, args, 1)));
  const pmt = toNumber(context.evaluateFormula(requiredArg(context, args, 2)));
  const pv = args.length >= 4 ? toNumber(context.evaluateFormula(requiredArg(context, args, 3))) : 0;
  const type = args.length >= 5 ? toNumber(context.evaluateFormula(requiredArg(context, args, 4))) : 0;

  return computeFv(rate, nper, pmt, pv, type);
};

/**
 * PV - Present Value
 * Calculates the present value of an investment based on periodic, constant payments and a constant interest rate.
 * PV(rate, nper, pmt, [fv], [type])
 */
const pvHandler: FunctionHandler = (args, context) => {
  const rate = toNumber(context.evaluateFormula(requiredArg(context, args, 0)));
  const nper = toNumber(context.evaluateFormula(requiredArg(context, args, 1)));
  const pmt = toNumber(context.evaluateFormula(requiredArg(context, args, 2)));
  const fv = args.length >= 4 ? toNumber(context.evaluateFormula(requiredArg(context, args, 3))) : 0;
  const type = args.length >= 5 ? toNumber(context.evaluateFormula(requiredArg(context, args, 4))) : 0;

  return computePv(rate, nper, pmt, fv, type);
};

/**
 * PMT - Payment
 * Calculates the payment for a loan based on constant payments and a constant interest rate.
 * PMT(rate, nper, pv, [fv], [type])
 */
const pmtHandler: FunctionHandler = (args, context) => {
  const rate = toNumber(context.evaluateFormula(requiredArg(context, args, 0)));
  const nper = toNumber(context.evaluateFormula(requiredArg(context, args, 1)));
  const pv = toNumber(context.evaluateFormula(requiredArg(context, args, 2)));
  const fv = args.length >= 4 ? toNumber(context.evaluateFormula(requiredArg(context, args, 3))) : 0;
  const type = args.length >= 5 ? toNumber(context.evaluateFormula(requiredArg(context, args, 4))) : 0;

  return computePmt(rate, nper, pv, fv, type);
};

/**
 * NPER - Number of Periods
 * Calculates the number of periods for an investment based on periodic, constant payments and a constant interest rate.
 * NPER(rate, pmt, pv, [fv], [type])
 */
const nperHandler: FunctionHandler = (args, context) => {
  const rate = toNumber(context.evaluateFormula(requiredArg(context, args, 0)));
  const pmt = toNumber(context.evaluateFormula(requiredArg(context, args, 1)));
  const pv = toNumber(context.evaluateFormula(requiredArg(context, args, 2)));
  const fv = args.length >= 4 ? toNumber(context.evaluateFormula(requiredArg(context, args, 3))) : 0;
  const type = args.length >= 5 ? toNumber(context.evaluateFormula(requiredArg(context, args, 4))) : 0;

  return computeNper(rate, pmt, pv, fv, type);
};

/**
 * RATE - Interest Rate
 * Calculates the interest rate per period of an annuity.
 * RATE(nper, pmt, pv, [fv], [type], [guess])
 * Uses Newton-Raphson method for iteration
 */
const rateHandler: FunctionHandler = (args, context) => {
  const nper = toNumber(context.evaluateFormula(requiredArg(context, args, 0)));
  const pmt = toNumber(context.evaluateFormula(requiredArg(context, args, 1)));
  const pv = toNumber(context.evaluateFormula(requiredArg(context, args, 2)));
  const fv = args.length >= 4 ? toNumber(context.evaluateFormula(requiredArg(context, args, 3))) : 0;
  const type = args.length >= 5 ? toNumber(context.evaluateFormula(requiredArg(context, args, 4))) : 0;
  const guess = args.length >= 6 ? toNumber(context.evaluateFormula(requiredArg(context, args, 5))) : 0.1;

  return computeRate(nper, pmt, pv, fv, type, guess);
};

// IPMT and PPMT take the SAME six operands — (rate, per, nper, pv, [fv], [type])
// — and differ only in which annuity component they compute. One factory parses
// the shared shape so the two handlers can't drift in their optional-arg defaults.
type PeriodicComponent = (rate: number, per: number, nper: number, pv: number, fv: number, type: number) => number;

const makePeriodicComponentHandler =
  (compute: PeriodicComponent): FunctionHandler =>
  (args, context) => {
    const rate = toNumber(context.evaluateFormula(requiredArg(context, args, 0)));
    const per = toNumber(context.evaluateFormula(requiredArg(context, args, 1)));
    const nper = toNumber(context.evaluateFormula(requiredArg(context, args, 2)));
    const pv = toNumber(context.evaluateFormula(requiredArg(context, args, 3)));
    const fv = args.length >= 5 ? toNumber(context.evaluateFormula(requiredArg(context, args, 4))) : 0;
    const type = args.length >= 6 ? toNumber(context.evaluateFormula(requiredArg(context, args, 5))) : 0;

    return compute(rate, per, nper, pv, fv, type);
  };

/**
 * IPMT - Interest Payment
 * Calculates the interest payment for a given period for an investment based on periodic, constant payments and a constant interest rate.
 * IPMT(rate, per, nper, pv, [fv], [type])
 */
const ipmtHandler: FunctionHandler = makePeriodicComponentHandler(computeIpmt);

/**
 * PPMT - Principal Payment
 * Calculates the payment on the principal for a given period for an investment based on periodic, constant payments and a constant interest rate.
 * PPMT(rate, per, nper, pv, [fv], [type])
 */
const ppmtHandler: FunctionHandler = makePeriodicComponentHandler(computePpmt);

/**
 * NPV - Net Present Value
 * Calculates the net present value of an investment based on a discount rate and a series of future cash flows.
 * NPV(rate, value1, [value2], ...)
 */
// Flatten NPV's value arguments into one ordered list of numeric cash flows:
// ranges expand in place (numeric cells only), scalars contribute one value.
// The order defines each flow's discount period, so ranges and the scalars
// after them must stay in argument order.
const collectCashFlows = (valueArgs: string[], context: FunctionContext): number[] =>
  valueArgs.flatMap((arg) => (arg.includes(":") ? context.getRangeValues(arg) : [context.evaluateFormula(arg)]).map(toNumber));

const npvHandler: FunctionHandler = (args, context) => {
  const rate = toNumber(context.evaluateFormula(requiredArg(context, args, 0)));
  return computeNpv(rate, collectCashFlows(args.slice(1), context));
};

/**
 * IRR - Internal Rate of Return
 * Calculates the internal rate of return for a series of cash flows.
 * IRR(values, [guess])
 * Uses Newton-Raphson method for iteration
 */
const irrHandler: FunctionHandler = (args, context) => {
  const values = context.getRangeValues(requiredArg(context, args, 0)).map(toNumber);
  const guess = args.length === 2 ? toNumber(context.evaluateFormula(requiredArg(context, args, 1))) : 0.1;

  if (values.length === 0) {
    throw new Error("IRR requires at least one value");
  }

  return computeIrr(values, guess);
};

// Register all financial functions
functionRegistry.register({
  name: "FV",
  handler: fvHandler,
  minArgs: 3,
  maxArgs: 5,
  description: "Calculates the future value of an investment based on periodic, constant payments and a constant interest rate",
  examples: ["FV(0.06/12, 12, -100, -1000, 1)", "FV(A1, A2, A3)"],
  category: "Financial",
});

functionRegistry.register({
  name: "PV",
  handler: pvHandler,
  minArgs: 3,
  maxArgs: 5,
  description: "Calculates the present value of an investment based on periodic, constant payments and a constant interest rate",
  examples: ["PV(0.08/12, 12*20, 500, 0, 0)", "PV(A1, A2, A3)"],
  category: "Financial",
});

functionRegistry.register({
  name: "PMT",
  handler: pmtHandler,
  minArgs: 3,
  maxArgs: 5,
  description: "Calculates the payment for a loan based on constant payments and a constant interest rate",
  examples: ["PMT(0.06/12, 30*12, 250000)", "PMT(A1, A2, A3)"],
  category: "Financial",
});

functionRegistry.register({
  name: "NPER",
  handler: nperHandler,
  minArgs: 3,
  maxArgs: 5,
  description: "Calculates the number of periods for an investment based on periodic, constant payments and a constant interest rate",
  examples: ["NPER(0.06/12, -1000, 50000, 0, 0)", "NPER(A1, A2, A3)"],
  category: "Financial",
});

functionRegistry.register({
  name: "RATE",
  handler: rateHandler,
  minArgs: 3,
  maxArgs: 6,
  description: "Calculates the interest rate per period of an annuity using iteration",
  examples: ["RATE(12, -100, 1000, 0, 0, 0.1)", "RATE(A1, A2, A3)"],
  category: "Financial",
});

functionRegistry.register({
  name: "IPMT",
  handler: ipmtHandler,
  minArgs: 4,
  maxArgs: 6,
  description: "Calculates the interest payment for a given period for an investment",
  examples: ["IPMT(0.06/12, 1, 30*12, 250000)", "IPMT(A1, A2, A3, A4)"],
  category: "Financial",
});

functionRegistry.register({
  name: "PPMT",
  handler: ppmtHandler,
  minArgs: 4,
  maxArgs: 6,
  description: "Calculates the payment on the principal for a given period for an investment",
  examples: ["PPMT(0.06/12, 1, 30*12, 250000)", "PPMT(A1, A2, A3, A4)"],
  category: "Financial",
});

functionRegistry.register({
  name: "NPV",
  handler: npvHandler,
  minArgs: 2,
  description: "Calculates the net present value of an investment based on a discount rate and a series of future cash flows",
  examples: ["NPV(0.1, -10000, 3000, 4200, 6800)", "NPV(A1, B1:B10)"],
  category: "Financial",
});

functionRegistry.register({
  name: "IRR",
  handler: irrHandler,
  minArgs: 1,
  maxArgs: 2,
  description: "Calculates the internal rate of return for a series of cash flows",
  examples: ["IRR(A1:A5, 0.1)", "IRR(B1:B10)"],
  category: "Financial",
});
