// Pure decision + presentation logic for the list-table flag-filter chips:
// the tri-state transition (all → hide → only → all), the own-property mode
// read, the state rebuild on a cycle, and the icon / colour mappings. Split out
// of the component (mirroring `tableSortDisplay.ts`) so the state machine and
// the prototype-shadow guard are unit-testable and the composable stays a thin
// reactive shell.

import { completionCoveredByFieldChip, type FlagChip } from "@mulmoclaude/core/collection";
import type { FlagFilterMode, FlagFilterState } from "./collectionViewMode";

/** The minimal schema slice `buildFlagChips` reads — the full `CollectionSchema`
 *  satisfies it structurally, and it stays small enough to build in a test. */
export interface FlagChipSchemaView {
  fields: Record<string, { type: string; label?: string; field?: string; onValue?: string }>;
  completionField?: string | undefined;
  completionDoneValues?: readonly string[] | undefined;
}

/** Chip key (state/testid/localStorage) for the synthesized legacy-completion
 *  chip. Field names are unrestricted, so a schema COULD declare a field with
 *  this exact name — `buildFlagChips` skips synthesizing in that case, and the
 *  predicate dispatch keys off the structural `synthetic` marker, never this
 *  string. */
const COMPLETION_CHIP_KEY = "__completion";

/** The field types that earn a filter-menu entry: declared predicates (`flag`)
 *  plus the fields that ARE a predicate already — a stored `boolean` and a
 *  `toggle`'s projected on/off state. Enums stay out (kanban slices by enum). */
const CHIP_FIELD_TYPES = new Set(["flag", "boolean", "toggle"]);

/** The filter chips for a schema: one per predicate-shaped field, plus a
 *  synthesized "done" chip for a legacy completion pair (no flag field). The
 *  done chip's label is passed in already-translated so this stays i18n-free and
 *  testable. */
export function buildFlagChips(schema: FlagChipSchemaView, doneChipLabel: string): FlagChip[] {
  const chips: FlagChip[] = Object.entries(schema.fields)
    .filter(([, field]) => CHIP_FIELD_TYPES.has(field.type))
    .map(([key, field]) => ({ key, label: field.label ?? key }));
  // A flag-form completion is already covered by that flag's own chip, and a pair
  // a boolean/toggle chip expresses exactly is covered by THAT chip. Skipped when
  // a field is named `__completion`, so the chip key can never collide.
  if (
    schema.completionField &&
    schema.completionDoneValues &&
    schema.fields[schema.completionField]?.type !== "flag" &&
    !completionCoveredByFieldChip(schema) &&
    schema.fields[COMPLETION_CHIP_KEY] === undefined
  ) {
    chips.push({ key: COMPLETION_CHIP_KEY, label: doneChipLabel, synthetic: true });
  }
  return chips;
}

/** The next mode a chip cycles to: all (undefined) → hide → only → all. */
export function nextFlagFilterMode(current: FlagFilterMode | undefined): FlagFilterMode | undefined {
  if (current === undefined) return "hide";
  if (current === "hide") return "only";
  return undefined;
}

/** Own-property read of a chip's active mode. Field names may shadow
 *  `Object.prototype` members (`toString`, `valueOf`, …) — a plain
 *  `filters[key]` on such a key reads the inherited function, which renders as
 *  an "active" chip that can never cycle (Codex review on PR #2176). Every
 *  chip-state read goes through here. */
export function flagFilterModeOf(filters: FlagFilterState, key: string): FlagFilterMode | undefined {
  return Object.hasOwn(filters, key) ? filters[key] : undefined;
}

/** The filter state after cycling one chip's mode. Rebuilds without the key
 *  (avoiding a dynamic `delete`) then re-adds it only when the next mode is
 *  active, so clearing a chip leaves no stale key behind. */
export function cycleFlagFilterState(filters: FlagFilterState, key: string): FlagFilterState {
  const next = nextFlagFilterMode(flagFilterModeOf(filters, key));
  const rest = Object.fromEntries(Object.entries(filters).filter(([entry]) => entry !== key));
  return next ? { ...rest, [key]: next } : rest;
}

// Checkbox metaphor for the tri-state: checked = only the ON rows, unchecked =
// only the OFF rows, faint unchecked = not filtering. The glyph alone can't show
// the third state (Material Icons has no dotted box), so the icon COLOUR greys
// it out instead.
export function flagChipIconForMode(mode: FlagFilterMode | undefined): string {
  return mode === "only" ? "check_box" : "check_box_outline_blank";
}

export function flagChipIconClassForMode(mode: FlagFilterMode | undefined): string {
  if (mode === "hide") return "text-slate-600";
  if (mode === "only") return "text-indigo-600";
  return "text-slate-300";
}

// Menu-entry state tints: slate for "hide" (rows removed), indigo for "only"
// (rows isolated), neutral when inactive.
export function flagChipClassForMode(mode: FlagFilterMode | undefined): string {
  if (mode === "hide") return "bg-slate-100 text-slate-700";
  if (mode === "only") return "bg-indigo-50 text-indigo-700";
  return "text-slate-500";
}
