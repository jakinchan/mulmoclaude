// Shape a manual Google Calendar sync (#2427) into the refresh response the
// CollectionView already understands. Pure, so the reporting rule — which
// counts belong to the requested collection, and which states must not read as
// a successful empty sync — is testable without a workspace or a Google grant.
import type { CalendarCollectionSyncResult, ManualCalendarSyncOutcome } from "@mulmoclaude/core/google";

export interface CollectionRefreshBody {
  refreshed: true;
  written: number;
  errors: string[];
  /** Records the sync deleted (an event cancelled in Google). Calendar only —
   *  a feed refresh never removes records. */
  removed?: number | undefined;
  dispatched?: boolean | undefined;
  chatId?: string | undefined;
}

export const CALENDAR_NOT_LINKED_ERROR = "no Google account is linked on this host — link it in Settings → Google";
export const CALENDAR_NOT_DECLARED_ERROR = "this collection no longer declares a `googleCalendar` block";

function totals(results: readonly CalendarCollectionSyncResult[], pick: (result: CalendarCollectionSyncResult) => number): number {
  return results.reduce((total, result) => total + pick(result), 0);
}

/** A sync of the whole calendar group reported for ONE collection: the group
 *  fan-out is a correctness requirement of the shared sync token, but the user
 *  asked about `slug`, so only its own counts are reported.
 *
 *  `unwritable` events join `errors` here even though they never retry — the
 *  clicking user is the one person who can act on them. */
export function calendarRefreshBody(slug: string, outcome: ManualCalendarSyncOutcome): CollectionRefreshBody {
  if (outcome.kind === "not-linked") return { refreshed: true, written: 0, errors: [CALENDAR_NOT_LINKED_ERROR] };
  if (outcome.kind === "not-a-calendar") return { refreshed: true, written: 0, errors: [CALENDAR_NOT_DECLARED_ERROR] };
  const own = outcome.results.filter((result) => result.slug === slug);
  return {
    refreshed: true,
    written: totals(own, (result) => result.written),
    removed: totals(own, (result) => result.removed),
    errors: own.flatMap((result) => [...result.errors, ...result.unwritable]),
  };
}
