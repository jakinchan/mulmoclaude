// Parser for the `at` mini-DSL used inside `firingPlan[].at` and
// `steps[].deadline`.
//
// Grammar:
//   at-expr   := anchor [ offset ]
//   anchor    := "cycle-start" | "cycle-deadline" | "step-deadline" | "schedule:" iso-date
//   offset    := ("+" | "-") integer "d"
//   iso-date  := YYYY "-" MM "-" DD
//
// Examples:
//   cycle-start
//   cycle-start+30d
//   cycle-deadline-21d
//   cycle-deadline
//   cycle-deadline+1d
//   step-deadline-3d
//   schedule:2026-02-01
//
// `step-deadline` is only valid INSIDE a step's `firingPlan`; the
// caller supplies an `allowStepDeadline` flag and the parser rejects
// it everywhere else (notably inside a step's `deadline` field
// itself).
//
// Pure module: no fs, no clock; resolution happens in
// `./at-resolver.ts` against cycle anchors.

import { z } from "zod";

export type AtAnchor = "cycle-start" | "cycle-deadline" | "step-deadline" | "schedule";

export interface AtExpression {
  /** Which anchor the expression resolves against. */
  anchor: AtAnchor;
  /** Day offset added to the anchor. 0 for bare anchors. */
  offsetDays: number;
  /** Absolute ISO date, only present when anchor === "schedule". */
  date?: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a raw at-expression string. Throws on malformed input. */
export function parseAtExpression(raw: string, opts: { allowStepDeadline: boolean }): AtExpression {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("at-expression: must be a non-empty string");
  }

  // schedule:<iso-date> is its own shape — no offset allowed in v1.
  if (raw.startsWith("schedule:")) {
    const rest = raw.slice("schedule:".length);
    if (!ISO_DATE_RE.test(rest)) {
      throw new Error(`at-expression: "schedule:<YYYY-MM-DD>" expected, got ${JSON.stringify(raw)}`);
    }
    return { anchor: "schedule", offsetDays: 0, date: rest };
  }

  // anchor [+/-]Nd
  const offsetMatch = raw.match(/^([a-z-]+)(?:([+-])(\d+)d)?$/);
  if (!offsetMatch) {
    throw new Error(`at-expression: ${JSON.stringify(raw)} does not match grammar (anchor [±Nd])`);
  }
  const [, anchorStr, sign, days] = offsetMatch;
  let anchor: AtAnchor;
  switch (anchorStr) {
    case "cycle-start":
      anchor = "cycle-start";
      break;
    case "cycle-deadline":
      anchor = "cycle-deadline";
      break;
    case "step-deadline":
      if (!opts.allowStepDeadline) {
        throw new Error(`at-expression: "step-deadline" is only valid inside a step's firingPlan, not in ${JSON.stringify(raw)}`);
      }
      anchor = "step-deadline";
      break;
    default:
      throw new Error(`at-expression: unknown anchor ${JSON.stringify(anchorStr)} (expected one of cycle-start, cycle-deadline, step-deadline, schedule:DATE)`);
  }

  const offsetDays = sign && days ? (sign === "+" ? 1 : -1) * Number.parseInt(days, 10) : 0;
  return { anchor, offsetDays };
}

/** Zod refinement helper that validates a string against the
 *  grammar. Use via `.superRefine` since the `allowStepDeadline`
 *  flag depends on where in the DSL tree the expression appears. */
export function atExprSchema(opts: { allowStepDeadline: boolean }): z.ZodType<string> {
  return z.string().superRefine((value, ctx) => {
    try {
      parseAtExpression(value, opts);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
