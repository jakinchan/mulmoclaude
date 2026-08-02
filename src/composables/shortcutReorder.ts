// Pure ordering logic for the pinned-shortcut reorder popover. Kept
// separate from `useShortcuts` (which owns the persist / IO) so the
// array math is unit-testable without a store or a network stub.
//
// The persisted order IS the array order — `normalizeShortcuts`
// (server) and `reconcile` (client) both preserve it — so reordering
// only rewrites the same members in a new sequence; no schema field.
//
// Intent is expressed as (kind, slug, direction), NOT a precomputed
// array: the store resolves it against the authoritative list at the
// moment the mutation runs (inside the serialized queue). Passing a
// snapshot captured at click time would go stale whenever the queue is
// busy (a `reconcile()` PUT in flight), so two rapid clicks could
// enqueue the same move and the second would no-op.

import { sameShortcut, type Shortcut } from "../types/shortcuts";

export type MoveDirection = "up" | "down";

/** Move the item at `index` one slot in `direction`, returning a NEW
 *  array. An out-of-range index, or a move that would fall off either
 *  end (up from first / down from last), returns the SAME array
 *  reference unchanged so the caller can skip a needless persist. Never
 *  mutates the input. */
export function moveShortcut(list: Shortcut[], index: number, direction: MoveDirection): Shortcut[] {
  const target = direction === "up" ? index - 1 : index + 1;
  const moved = list[index];
  const displaced = list[target];
  if (!moved || !displaced) return list;
  const next = [...list];
  next[index] = displaced;
  next[target] = moved;
  return next;
}

/** Resolve a move intent against `list`: locate the entry by (kind, slug)
 *  and move it one slot in `direction`. Returns the SAME reference when
 *  the entry isn't present or is already at the relevant end (no-op).
 *  Because it reorders `list`'s own objects, each entry's metadata comes
 *  from `list` — pass the authoritative current list at execution time
 *  and repeated calls compose (move the same item down twice → two
 *  slots). Never mutates the input. */
export function moveShortcutByIdentity(list: Shortcut[], kind: Shortcut["kind"], slug: string, direction: MoveDirection): Shortcut[] {
  const index = list.findIndex((entry) => sameShortcut(entry, { kind, slug }));
  if (index < 0) return list;
  return moveShortcut(list, index, direction);
}
