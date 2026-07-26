// Reading a Collection → Google Calendar push result (#2598).
//
// Pure and separate from the view so the rule that decides "did this push have
// something the user must act on" is testable without mounting a component —
// and so `pushCalendar` stays a short orchestration function.
import type { CollectionPushResult } from "./uiContext";

/** Everything the user has to act on, in one list.
 *
 *  `errors` (an unlinked account, a read-only calendar, an API failure) and
 *  `skipped` (a record that cannot be pushed as it stands) are separate fields
 *  on the response because they need different wording upstream, but both mean
 *  "this click did not do what you asked" — so both must reach the banner. A
 *  push that reported only its counts would render a setup failure as
 *  "0 created", which reads as "nothing to do". */
export function pushProblems(result: CollectionPushResult): string[] {
  return [...result.errors, ...result.skipped];
}

/** Whether anything reached Google. Conflicts and local deletions are reported
 *  but deliberately not acted on, so they do not count as work done. */
export function pushWroteSomething(result: CollectionPushResult): boolean {
  return result.created > 0 || result.updated > 0;
}
