// Pure `when`-predicate visibility helpers for schema-driven
// collections — used both for action buttons and for conditionally
// shown fields. Kept as their own module (no Vue) so CollectionView
// can stay thin and the match semantics are pinned by unit tests.
// Domain-free: the host compares the stringified record value against
// the allowed set with no knowledge of what the field means.

/** A `when` predicate: render only when the open record's `field`
 *  (stringified) is one of `in`. Shared shape for action buttons and
 *  conditionally visible fields. */
export interface WhenPredicate {
  field: string;
  in: string[];
}

/** Core matcher:
 *  - no `when` ⇒ always true (visible);
 *  - otherwise true only when `record[when.field]` is present and its
 *    stringified value is one of `when.in`.
 *  A missing/undefined/null field is treated as "not a match"
 *  (hidden), so a status-gated target never shows on a record that
 *  lacks the status. */
export function whenMatches(when: WhenPredicate | undefined, record: Record<string, unknown>): boolean {
  if (!when) return true;
  const value = record[when.field];
  if (value === undefined || value === null) return false;
  return when.in.includes(String(value));
}

/** Minimal shape this helper needs from an action — just its optional
 *  `when` predicate. Accepts the full CollectionAction too. */
export interface ActionWithWhen {
  when?: WhenPredicate;
}

/** True when the action's button should render against `record`
 *  (see whenMatches). */
export function actionVisible(action: ActionWithWhen, record: Record<string, unknown>): boolean {
  return whenMatches(action.when, record);
}

/** Minimal shape this helper needs from a field spec — just its
 *  optional `when` predicate. Accepts the full FieldSpec too. */
export interface FieldWithWhen {
  when?: WhenPredicate;
}

/** True when the field should render against `record`. A field with
 *  no `when` is always shown; otherwise it's shown only when the
 *  record matches (e.g. hide a rating field until `visited` is true).
 *  Purely presentational — a hidden field's stored value is never
 *  altered, so toggling the gate back on restores it. */
export function fieldVisible(field: FieldWithWhen, record: Record<string, unknown>): boolean {
  return whenMatches(field.when, record);
}
