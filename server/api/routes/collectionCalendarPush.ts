// Shape a Collection → Google Calendar push (#2598) into the response the
// CollectionView reports. Pure, so the rule that decides which states must NOT
// read as a successful empty push is testable without a workspace or a grant.
import type { CalendarCollectionPushResult, CalendarPushOutcome } from "@mulmoclaude/core/google";

export interface CollectionPushBody {
  pushed: true;
  created: number;
  updated: number;
  /** Edited on both sides — skipped so neither version is lost. */
  conflicts: number;
  /** Records deleted locally. Reported only: v1 never deletes in Google. */
  localDeletes: number;
  /** Records that could not be pushed as they stand, each with its reason. */
  skipped: string[];
  errors: string[];
}

export const PUSH_NOT_LINKED_ERROR = "no Google account is linked on this host — link it in Settings → Google";
export const PUSH_NOT_DECLARED_ERROR = "this collection does not declare a `googleCalendar` block, so there is no calendar to push to";

/** A `reader` grant fails per event with an opaque 403, so the role is checked
 *  once and reported as the setup problem it is. */
export const pushReadOnlyError = (accessRole: string): string =>
  `you only have ${accessRole || "read"} access to this calendar — pushing needs owner or writer access`;

const empty = (errors: string[]): CollectionPushBody => ({ pushed: true, created: 0, updated: 0, conflicts: 0, localDeletes: 0, skipped: [], errors });

const fromResult = (result: CalendarCollectionPushResult): CollectionPushBody => ({
  pushed: true,
  created: result.created,
  updated: result.updated,
  conflicts: result.conflicts,
  localDeletes: result.localDeletes,
  skipped: result.skipped,
  errors: result.errors,
});

/** Every non-`pushed` outcome becomes an error, never a quiet zero: a click that
 *  answers "0 created" reads as "nothing to do", which is exactly wrong when the
 *  real answer is "your account isn't linked" or "you can't write here". */
export function calendarPushBody(outcome: CalendarPushOutcome): CollectionPushBody {
  if (outcome.kind === "not-linked") return empty([PUSH_NOT_LINKED_ERROR]);
  if (outcome.kind === "not-a-calendar") return empty([PUSH_NOT_DECLARED_ERROR]);
  if (outcome.kind === "read-only") return empty([pushReadOnlyError(outcome.accessRole)]);
  if (outcome.kind === "failed") return empty([outcome.message]);
  return fromResult(outcome.result);
}
