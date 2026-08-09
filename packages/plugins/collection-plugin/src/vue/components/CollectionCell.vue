<template>
  <td class="px-5 py-2 text-slate-700 align-middle max-w-xs font-medium">
    <!-- Conditionally hidden field (`when` predicate) → blank cell. -->
    <template v-if="fieldVisible(field, item)">
      <!-- Toggle → inline checkbox projecting an enum field.
           Stores nothing itself; toggling writes onValue/
           offValue to the projected field via the same PUT. -->
      <input
        v-if="field.type === 'toggle'"
        type="checkbox"
        :checked="toggleChecked(item, field)"
        :disabled="isReadOnly || rowInlineSaving"
        class="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 cursor-pointer align-middle disabled:opacity-50 disabled:cursor-not-allowed"
        :data-testid="`collections-inline-toggle-${fieldKey}-${item[collection.schema.primaryKey]}`"
        :aria-label="field.label"
        @click.stop
        @change="$emit('commitToggle', item, field)"
      />

      <!-- Boolean → inline checkbox. Tap toggles + saves
           immediately; `@click.stop` so it doesn't open the
           row's detail panel. Unset (undefined) and explicit
           false both render unchecked. -->
      <input
        v-else-if="field.type === 'boolean'"
        type="checkbox"
        :checked="item[fieldKey] === true"
        :disabled="isReadOnly || rowInlineSaving"
        class="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 cursor-pointer align-middle disabled:opacity-50 disabled:cursor-not-allowed"
        :data-testid="`collections-inline-bool-${fieldKey}-${item[collection.schema.primaryKey]}`"
        :aria-label="field.label"
        @click.stop
        @change="onBoolChange"
      />

      <!-- Flag (computed boolean predicate) → read-only check.
           Never stored; recomputed by deriveAll, so there is
           nothing to edit inline. -->
      <span
        v-else-if="field.type === 'flag'"
        class="material-icons text-lg align-middle"
        :class="flagValueOf(String(fieldKey), item) ? 'text-emerald-600' : 'text-slate-300'"
        :data-testid="`collections-flag-${fieldKey}-${item[collection.schema.primaryKey]}`"
        :aria-label="`${field.label}: ${t(flagValueOf(String(fieldKey), item) ? 'common.yes' : 'common.no')}`"
        role="img"
        >{{ flagValueOf(String(fieldKey), item) ? "check_circle" : "radio_button_unchecked" }}</span
      >

      <!-- Ref link badge (binding-driven nav, router-optional) -->
      <span v-else-if="field.type === 'ref' && field.to && typeof item[fieldKey] === 'string' && item[fieldKey]" class="block truncate">
        <a
          :href="cui.recordHref?.(field.to, String(item[fieldKey]))"
          :tabindex="cui.recordHref?.(field.to, String(item[fieldKey])) ? undefined : 0"
          role="link"
          class="text-indigo-600 hover:text-indigo-800 hover:underline font-semibold"
          :data-testid="`collections-ref-link-${fieldKey}-${item[fieldKey]}`"
          @click="activateRefLink($event, field.to, String(item[fieldKey]), true)"
          @keydown.enter="activateRefLink($event, field.to, String(item[fieldKey]), true)"
          @keydown.space="activateRefLink($event, field.to, String(item[fieldKey]), true)"
          >{{ render.refDisplay(field.to, String(item[fieldKey])) }}</a
        >
      </span>

      <!-- Enum → inline dropdown. Selecting writes + saves
           immediately; the empty placeholder clears the field.
           `@click.stop` keeps the row's detail panel closed. -->
      <select
        v-else-if="field.type === 'enum' && Array.isArray(field.values) && field.values.length > 0"
        :value="item[fieldKey] == null ? '' : String(item[fieldKey])"
        :disabled="isReadOnly || rowInlineSaving"
        class="rounded-lg border px-2 py-0.5 text-[11px] font-semibold focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        :class="enumControlClass(String(fieldKey), item[fieldKey])"
        :data-testid="`collections-inline-enum-${fieldKey}-${item[collection.schema.primaryKey]}`"
        :aria-label="field.label"
        @click.stop
        @change="onEnumChange"
      >
        <option v-if="showEnumPlaceholder(item, String(fieldKey))" value="">{{ t("collectionsView.selectPlaceholder") }}</option>
        <option v-for="value in field.values" :key="value" :value="value">{{ value }}</option>
      </select>

      <!-- Money -->
      <span v-else-if="field.type === 'money'" class="block truncate tabular-nums font-semibold text-slate-900">{{
        render.formatMoney(item[fieldKey], render.resolveCurrency(field, item), locale)
      }}</span>

      <!-- Table summary counter -->
      <span
        v-else-if="field.type === 'table'"
        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200/40"
      >
        <span class="material-icons text-[11px]">list</span>
        <span>{{ tableSummary(item[fieldKey]) }}</span>
      </span>

      <!-- Derived formula fields -->
      <span
        v-else-if="field.type === 'derived'"
        class="inline-block truncate tabular-nums font-bold text-indigo-900 bg-indigo-50/50 px-1.5 py-0.5 rounded border border-indigo-100/50"
        >{{ render.derivedDisplay(field, render.evaluateDerivedAgainstItem(field, String(fieldKey), item), item) }}</span
      >

      <!-- Rollup aggregates (cross-collection, host/client-computed) -->
      <span
        v-else-if="field.type === 'rollup'"
        class="inline-block truncate tabular-nums font-bold text-indigo-900 bg-indigo-50/50 px-1.5 py-0.5 rounded border border-indigo-100/50"
        :data-testid="`collections-rollup-${fieldKey}-${item[collection.schema.primaryKey]}`"
        >{{ render.rollupDisplay(field, item) }}</span
      >

      <!-- URL string → external link (new tab). `@click.stop` so
       clicking the link doesn't also open the row's detail. -->
      <a
        v-else-if="field.type !== 'file' && render.isExternalUrl(item[fieldKey])"
        :href="String(item[fieldKey])"
        target="_blank"
        rel="noopener noreferrer"
        class="block truncate text-blue-600 hover:text-blue-800 hover:underline font-semibold"
        :data-testid="`collections-url-link-${fieldKey}-${item[collection.schema.primaryKey]}`"
        @click.stop
        >{{ String(item[fieldKey]) }}</a
      >

      <!-- File: served HTML/SVG artifact → open the rendered
           app in a new tab. `@click.stop` keeps the row's
           detail panel from also opening. -->
      <a
        v-else-if="field.type === 'file' && render.artifactUrl(item[fieldKey])"
        :href="render.artifactUrl(item[fieldKey]) ?? undefined"
        target="_blank"
        rel="noopener noreferrer"
        class="block truncate text-blue-600 hover:text-blue-800 hover:underline font-semibold"
        :data-testid="`collections-file-link-${fieldKey}-${item[collection.schema.primaryKey]}`"
        @click.stop
        >{{ String(item[fieldKey]) }}</a
      >

      <!-- File: any other workspace path → open in File Explorer. -->
      <a
        v-else-if="field.type === 'file' && render.fileRoutePath(item[fieldKey])"
        :href="render.fileRoutePath(item[fieldKey]) ?? undefined"
        class="block truncate text-blue-600 hover:text-blue-800 hover:underline font-semibold"
        :data-testid="`collections-file-link-${fieldKey}-${item[collection.schema.primaryKey]}`"
        @click="activatePathLink($event, render.fileRoutePath(item[fieldKey]) ?? '', true)"
        >{{ String(item[fieldKey]) }}</a
      >

      <span v-else class="block truncate text-slate-600">{{ render.formatCell(item[fieldKey], field.type) }}</span>
    </template>
  </td>
</template>

<script setup lang="ts">
import { useCollectionUi } from "../scopedUi";
import { useCollectionI18n } from "../lang";
import { useRefLinkActivators } from "../refLink";
import type { CollectionRendering } from "../useCollectionRendering";
import {
  cellKey,
  fieldVisible,
  flagFieldValue,
  resolveEnumColor,
  rowIdOf,
  toggleChecked,
  type CollectionDetail,
  type CollectionItem,
  type CollectionFieldSpec as FieldSpec,
} from "@mulmoclaude/core/collection";

// Link activation resolves the binding at click time, so a scoped card's plain
// clicks navigate in the card's project — like the `href` beside them.
const { activateRefLink, activatePathLink } = useRefLinkActivators();

const props = defineProps<{
  field: FieldSpec;
  item: CollectionItem;
  /** The column's field key (was `key` in the parent's `v-for`). */
  fieldKey: string;
  collection: CollectionDetail;
  /** Shared rendering/derivation helpers + ref/embed caches. */
  render: CollectionRendering;
  isReadOnly: boolean;
  /** This row has an inline cell save in flight (controls render disabled). */
  rowInlineSaving: boolean;
  /** Cells (keyed `<rowId>:<fieldKey>`) that had no value at load time —
   *  only these offer the enum dropdown's empty placeholder option. */
  enumOriginallyEmpty: Set<string>;
}>();

const emit = defineEmits<{
  commitToggle: [item: CollectionItem, field: FieldSpec];
  commitInlineEdit: [item: CollectionItem, key: string, field: FieldSpec, raw: boolean | string];
}>();

const cui = useCollectionUi();
const { t, locale } = useCollectionI18n();

/** A flag FIELD's computed boolean for one row: reads the enriched record so a
 *  flag over derived/rollup inputs is correct. */
function flagValueOf(key: string, item: CollectionItem): boolean {
  return flagFieldValue(props.render.deriveRecord(item), key);
}

/** Whether an inline enum dropdown should render its empty placeholder
 *  option: only for cells with no value at load time. */
function showEnumPlaceholder(item: CollectionItem, key: string): boolean {
  return props.enumOriginallyEmpty.has(cellKey(rowIdOf(props.collection.schema.primaryKey, item), key));
}

/** Tailwind fill/text/border classes tinting an inline enum `<select>` by its
 *  current value's colour. */
function enumControlClass(key: string, value: unknown): string {
  const cls = resolveEnumColor(props.collection.schema, key, value);
  return `${cls.badge} ${cls.border}`;
}

/** Short summary for a `table`-typed cell: row count, em-dash when empty. */
function tableSummary(value: unknown): string {
  if (!Array.isArray(value)) return "—";
  if (value.length === 0) return "—";
  return t("collectionsView.tableSummary", { count: value.length });
}

function onBoolChange(event: Event): void {
  const { target } = event;
  if (target instanceof HTMLInputElement) {
    emit("commitInlineEdit", props.item, String(props.fieldKey), props.field, target.checked);
  }
}

function onEnumChange(event: Event): void {
  const { target } = event;
  if (target instanceof HTMLSelectElement) {
    emit("commitInlineEdit", props.item, String(props.fieldKey), props.field, target.value);
  }
}
</script>
