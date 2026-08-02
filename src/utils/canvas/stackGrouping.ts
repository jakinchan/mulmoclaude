// Collapse a flat tool-result list into the cards StackView renders.
//
// Most results are their own card. Results that share a non-null
// group key (today: `mapControl` results with the same `groupId`)
// collapse into ONE card, positioned at the group's FIRST occurrence,
// with every later same-group result appended to `members` in order.
// `head` is the latest member (drives the card header + the View's
// legacy single-result fields).
//
// Grouping is session-wide, not contiguous: `A(g1), B, C(g1)` yields
// two cards — the g1 group `[A, C]` at index 0 and `B` at index 1.
// The card order returned here is the DOM order StackView renders, so
// scroll-spy / active-item logic MUST iterate THIS, not the original
// flat result list (a member that maps back to an earlier card would
// otherwise corrupt the active-item computation — Codex review on
// #1504).

export interface StackDisplayItem<T> {
  /** Stable v-for key: `group:<key>` for groups, the uuid otherwise. */
  key: string;
  /** Latest member — header + single-result View props derive from it. */
  head: T;
  /** All results in this card, in arrival order (1 for singletons). */
  members: T[];
  /** True when this card merges a multi-call group. */
  isGroup: boolean;
}

export function buildStackDisplayItems<T>(
  results: readonly T[],
  groupKeyOf: (result: T) => string | null,
  uuidOf: (result: T) => string,
): StackDisplayItem<T>[] {
  const items: StackDisplayItem<T>[] = [];
  // Holds the item itself, not its index: the same object lives in
  // `items`, so merging a later call mutates the card already queued.
  const itemByGroupKey = new Map<string, StackDisplayItem<T>>();
  for (const result of results) {
    const groupKey = groupKeyOf(result);
    if (groupKey === null) {
      items.push({ key: uuidOf(result), head: result, members: [result], isGroup: false });
      continue;
    }
    const existing = itemByGroupKey.get(groupKey);
    if (existing !== undefined) {
      existing.members.push(result);
      existing.head = result; // latest call drives the header
      continue;
    }
    const group: StackDisplayItem<T> = { key: `group:${groupKey}`, head: result, members: [result], isGroup: true };
    itemByGroupKey.set(groupKey, group);
    items.push(group);
  }
  return items;
}

// Scroll-spy core: given the rendered cards (already in DOM order) and a
// way to read each card's top coordinate, return the canonical uuid of
// the LAST card whose top edge is at or above `paddedTopPx`. Iterating
// `StackDisplayItem`s — not the flat result list — is the whole point:
// a merged group shares one element across several member uuids, so a
// flat walk would let a later member resolve back to the group's
// earlier element and wrongly win the active slot (Codex review on
// #1504). The early `break` relies on cards being top-sorted, which
// the rendered order guarantees.
export function pickActiveCardUuid<T>(
  items: readonly StackDisplayItem<T>[],
  uuidOf: (result: T) => string,
  topOfCardPx: (headUuid: string) => number | null,
  paddedTopPx: number,
): string | null {
  let activeUuid: string | null = null;
  for (const item of items) {
    const headUuid = uuidOf(item.head);
    const topPx = topOfCardPx(headUuid);
    if (topPx === null) continue;
    if (topPx <= paddedTopPx) activeUuid = headUuid;
    else break;
  }
  return activeUuid;
}

export type LatestScrollTarget = { kind: "bottom" } | { kind: "card"; headUuid: string } | { kind: "none" };

// Where to scroll when a new result arrives. Usually the newest result
// creates/extends the BOTTOM card → scroll to the bottom. But session-
// wide grouping can merge a new result into an EARLIER card, so bottom-
// scrolling would jump away from where it rendered. Returns `bottom`
// only when the newest result lands in the last card; otherwise the
// (earlier) card to bring into view (Codex review on #1504).
export function resolveLatestScrollTarget<T>(items: readonly StackDisplayItem<T>[], newest: T | undefined, uuidOf: (result: T) => string): LatestScrollTarget {
  if (newest === undefined) return { kind: "none" };
  const newestUuid = uuidOf(newest);
  const containsNewest = (item: StackDisplayItem<T>): boolean => item.members.some((member) => uuidOf(member) === newestUuid);
  const lastCard = items[items.length - 1];
  if (lastCard !== undefined && containsNewest(lastCard)) return { kind: "bottom" };
  const card = items.find(containsNewest);
  return card === undefined ? { kind: "none" } : { kind: "card", headUuid: uuidOf(card.head) };
}
