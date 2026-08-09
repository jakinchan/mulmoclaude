<template>
  <!-- Read-only reverse-ref sub-table: the records in `view.fromSlug`
       whose `via` ref points at the open record. Each row is a link to
       that record's own detail view (record → record hop, like a `ref`
       cell). Fail-soft by design: an unloadable source collection and
       "no matching rows" share the same quiet empty state. -->
  <div
    v-if="view.rows.length > 0"
    class="border border-slate-200/80 rounded-xl overflow-hidden shadow-sm mt-1"
    :data-testid="`collections-backlinks-${fieldKey}`"
  >
    <table class="w-full text-[11px] text-slate-600 bg-white">
      <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase tracking-wider">
        <tr>
          <th v-for="column in view.columns" :key="column.key" class="text-left px-4 py-2 font-bold">{{ column.label }}</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100">
        <tr
          v-for="row in view.rows"
          :key="row.id"
          class="group hover:bg-indigo-50/30 cursor-pointer transition-colors"
          role="link"
          tabindex="0"
          :data-testid="`collections-backlinks-${fieldKey}-${row.id}`"
          @click="activateRefLink($event, view.fromSlug, row.id)"
          @keydown.enter="activateRefLink($event, view.fromSlug, row.id)"
          @keydown.space="activateRefLink($event, view.fromSlug, row.id)"
        >
          <td v-for="(cell, cellIdx) in row.cells" :key="view.columns[cellIdx]?.key ?? cellIdx" class="px-4 py-2 align-middle font-medium">
            <span :class="cellIdx === 0 ? 'text-indigo-600 group-hover:text-indigo-800 font-bold' : ''">{{ cell }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <span v-else class="text-slate-400 italic" :data-testid="`collections-backlinks-${fieldKey}`">{{ t("collectionsView.noRows") }}</span>
</template>

<script setup lang="ts">
// Navigation goes through the binding (`activateRefLink` →
// `navigateToRecord`), like every other ref/embed link site, so a
// router-less host (MulmoTerminal) can map it to its own view state.
import { useCollectionI18n } from "../lang";
import { useRefLinkActivators } from "../refLink";
import type { BacklinksView } from "@mulmoclaude/core/collection";

// Link activation resolves the binding at click time, so a scoped card's plain
// clicks navigate in the card's project — like the `href` beside them.
const { activateRefLink } = useRefLinkActivators();

defineProps<{ view: BacklinksView; fieldKey: string }>();

const { t } = useCollectionI18n();
</script>
