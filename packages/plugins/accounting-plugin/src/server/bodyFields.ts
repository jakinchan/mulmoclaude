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

/** Rebuilt field by field rather than narrowed with a predicate, so the
 *  returned object is one this function actually proved. A half-formed
 *  `{ kind: "month" }` reads as absent and the caller raises its own
 *  "period is required" — previously it reached the report builders and
 *  produced an `undefined-01` date. */
export const optionalReportPeriod = (value: unknown): ReportPeriod | undefined => {
  const period = optionalRecord(value);
  if (period?.kind === "month" && typeof period.period === "string") return { kind: "month", period: period.period };
  if (period?.kind === "range" && typeof period.from === "string" && typeof period.to === "string") {
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
