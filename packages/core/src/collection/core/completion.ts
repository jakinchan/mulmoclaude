// The "is this record done?" predicate — THE single implementation,
// shared by the notification reconciler (bell clearing, collection-watchers),
// spawn (successor-predicate fallback, ../server/spawn.ts), and view-side
// completion filters. Zod-free and I/O-free like the rest of `core/`, so
// it is browser-safe through the collection barrel.
//
// Two completion forms (see `CollectionSchemaZ`'s completion refine):
//  - legacy pair: `completionField` names a stored field and
//    `completionDoneValues` lists the values that mean done —
//    done ⇔ `String(item[completionField])` ∈ `completionDoneValues`.
//  - flag form: `completionField` names a `flag` field (and
//    `completionDoneValues` is absent) — done ⇔ the flag's `where`
//    matches. Evaluated directly against the raw record here (NOT read
//    from a materialized value) because callers like the reconciler and
//    spawn work on records straight off disk, before any `deriveAll`
//    enrichment. That raw evaluation is CORRECT BY CONSTRUCTION: a
//    schema-level refine rejects a completion flag whose `where`
//    references computed fields, so every condition reads stored data.

import { fieldText, fieldTextOrNull } from "./fieldText";
import { matchesWhere, type Where } from "./where";
import type { CollectionFieldSpec, CollectionItem } from "./schema";

/** The slice of a parsed schema the done predicate reads — minimal
 *  structural shape (like `DerivableSchema`) so the client and server
 *  `CollectionSchema` types both satisfy it as-is. */
export interface CompletionSchemaView {
  /** Optional so legacy-pair callers (and their test fixtures) that
   *  never consult field specs keep working; only the flag form needs
   *  to look the completion field up. */
  fields?: Record<string, { type: string; where?: Where }> | undefined;
  completionField?: string | undefined;
  completionDoneValues?: readonly string[] | undefined;
}

/** True iff the schema declares completion tracking AND `item` is done
 *  under whichever completion form the schema uses (see module doc). */
export function itemIsDone(schema: CompletionSchemaView, item: Record<string, unknown>): boolean {
  const { completionField, completionDoneValues } = schema;
  if (!completionField) return false;
  const spec = schema.fields?.[completionField];
  if (spec?.type === "flag" && spec.where) return matchesWhere(spec.where, item);
  if (!completionDoneValues) return false;
  // An array/object field has no text form; treat it as "not done" rather than
  // letting "[object Object]" match a configured done-value.
  const text = fieldTextOrNull(item[completionField]);
  if (text === null) return false;
  return completionDoneValues.includes(text);
}

/** The schema slice `completionCoveredByFieldChip` reads: field kinds (it
 *  inspects `boolean` / `toggle` variants' `field` / `onValue`) plus the
 *  completion pair. Minimal structural shape so both the client and server
 *  `CollectionSchema` types satisfy it as-is. */
export interface CompletionChipSchemaView {
  fields: Record<string, { type: string; field?: string; onValue?: string }>;
  completionField?: string | undefined;
  completionDoneValues?: readonly string[] | undefined;
}

/** True when an existing FIELD chip already expresses the legacy completion
 *  predicate exactly, so a synthesized "done" chip would be a duplicate: a
 *  boolean `completionField` (done ⇔ `"true"` ⇔ the boolean's own chip), or a
 *  `toggle` projecting the `completionField` whose `onValue` is the single
 *  done value (the todos-schema shape: toggle "Done" on `status` +
 *  `completionDoneValues: ["done"]`). A superset pair (extra done values)
 *  still synthesizes — no field chip covers it. */
export function completionCoveredByFieldChip(schema: CompletionChipSchemaView): boolean {
  const { completionField, completionDoneValues } = schema;
  if (completionDoneValues?.length !== 1) return false;
  const [doneValue] = completionDoneValues;
  if (schema.fields[completionField ?? ""]?.type === "boolean") return doneValue === "true";
  return Object.values(schema.fields).some((field) => field.type === "toggle" && field.field === completionField && field.onValue === doneValue);
}

/** Whether a `toggle` field reads as checked: its projected enum field currently
 *  equals `onValue`. The toggle stores nothing of its own, so this reads the raw
 *  projected value; a non-toggle field is never checked. */
export function toggleChecked(item: CollectionItem, field: CollectionFieldSpec): boolean {
  return field.type === "toggle" && fieldText(item[field.field]) === field.onValue;
}

/** A `flag` FIELD's boolean for one row, read off the already-enriched record
 *  (so a flag computed from derived/rollup inputs is correct). Strict `=== true`
 *  on purpose: a truthy non-boolean ("yes", 1) is NOT a set flag, so a stray
 *  value can never render as an active flag. */
export function flagFieldValue(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

/** One entry in the table's flag-filter menu: a real `flag` / `boolean` /
 *  `toggle` field, or the synthesized legacy-completion chip (`synthetic`,
 *  predicate = `itemIsDone`). */
export interface FlagChip {
  key: string;
  label: string;
  synthetic?: boolean;
}

/** The schema slice `chipMatches` reads: full field specs (it inspects the
 *  `toggle` variant's `field` / `onValue`) plus the completion pair that
 *  `itemIsDone` needs for the synthesized chip. */
export interface ChipMatchSchema {
  fields: Record<string, CollectionFieldSpec>;
  completionField?: string;
  completionDoneValues?: readonly string[];
}

/** Whether one row satisfies a chip's predicate: `itemIsDone` for the
 *  synthesized completion chip, the projected value for a `toggle`, the stored
 *  boolean for a `boolean`, else the computed flag value. The flag branch reads
 *  the ENRICHED record via the injected `deriveRecord` (kept a parameter so this
 *  stays pure and framework-free). */
export function chipMatches(
  chip: FlagChip,
  schema: ChipMatchSchema,
  item: CollectionItem,
  deriveRecord: (item: CollectionItem) => Record<string, unknown>,
): boolean {
  if (chip.synthetic) return itemIsDone(schema, item);
  const field = schema.fields[chip.key];
  if (field?.type === "toggle") return toggleChecked(item, field);
  if (field?.type === "boolean") return item[chip.key] === true;
  return flagFieldValue(deriveRecord(item), chip.key);
}
