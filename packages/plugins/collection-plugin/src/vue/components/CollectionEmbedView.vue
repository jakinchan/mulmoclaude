<template>
  <!-- Found: the whole card links to the embedded record's detail view,
       like a normal `ref` link (record → record hop). -->
  <a
    v-if="view.found"
    :href="cui.recordHref?.(view.targetSlug, view.recordId)"
    :tabindex="cui.recordHref?.(view.targetSlug, view.recordId) ? undefined : 0"
    role="link"
    class="group block relative rounded-xl border border-slate-200 bg-slate-50/50 p-4 pl-5 space-y-3 hover:bg-indigo-50/20 hover:border-indigo-200 transition-all duration-300 shadow-sm"
    :data-testid="`collections-embed-${fieldKey}`"
    @click="activateRefLink($event, view.targetSlug, view.recordId)"
    @keydown.enter="activateRefLink($event, view.targetSlug, view.recordId)"
    @keydown.space="activateRefLink($event, view.targetSlug, view.recordId)"
  >
    <!-- Left Accent Stripe -->
    <div class="absolute left-0 top-0 bottom-0 w-1 bg-indigo-500 rounded-l-xl transition-all duration-300 group-hover:w-1.5 group-hover:bg-indigo-600"></div>

    <!-- Header Reference Badge -->
    <div class="flex items-center justify-between text-[10px] font-bold text-indigo-600/90 tracking-wider uppercase">
      <div class="flex items-center gap-1.5">
        <span class="material-icons text-sm">link</span>
        <span>{{ view.targetSlug }}</span>
      </div>
      <span class="bg-indigo-100/60 text-indigo-700 px-1.5 py-0.5 rounded font-mono font-medium lowercase">{{ view.recordId }}</span>
    </div>

    <!-- Grid-based detail fields -->
    <div class="grid gap-x-4 gap-y-3 grid-cols-2">
      <div v-for="row in view.rows" :key="row.key" class="space-y-0.5">
        <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{{ row.label }}</div>
        <div class="text-xs text-slate-700 font-medium break-words" :data-testid="`collections-embed-${fieldKey}-${row.key}`">
          <template v-if="row.type === 'boolean'">
            <span v-if="row.value === true" class="material-icons text-emerald-600 text-sm align-middle">check_circle</span>
            <!-- eslint-disable-next-line @intlify/vue-i18n/no-raw-text -- bare "—" empty-value glyph, same treatment as the other read-only detail branches. -->
            <span v-else class="text-slate-300">—</span>
          </template>
          <p v-else-if="row.type === 'markdown'" class="whitespace-pre-wrap font-normal text-slate-600">{{ row.display }}</p>
          <span v-else>{{ row.display }}</span>
        </div>
      </div>
    </div>
  </a>

  <div v-else class="relative rounded-xl border border-red-100 bg-red-50/30 p-4 pl-5 shadow-sm" :data-testid="`collections-embed-${fieldKey}`">
    <!-- Left Accent Stripe for Error/Missing -->
    <div class="absolute left-0 top-0 bottom-0 w-1 bg-red-400 rounded-l-xl"></div>
    <div class="flex items-start gap-3">
      <span class="material-icons text-red-500 text-lg mt-0.5">error_outline</span>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-semibold text-red-800 uppercase tracking-wider mb-1">{{ t("collectionsView.embedMissingTitle") }}</p>
        <p class="text-xs text-red-600" :data-testid="`collections-embed-missing-${fieldKey}`">
          {{ t("collectionsView.embedMissing", { collection: view.targetSlug, id: view.recordId }) }}
        </p>
        <a
          v-if="view.targetSlug"
          :href="cui.recordHref?.(view.targetSlug)"
          :tabindex="cui.recordHref?.(view.targetSlug) ? undefined : 0"
          role="link"
          class="inline-flex items-center gap-0.5 text-xs text-indigo-600 hover:text-indigo-800 font-semibold mt-2 hover:underline"
          @click="activateRefLink($event, view.targetSlug)"
          @keydown.enter="activateRefLink($event, view.targetSlug)"
          @keydown.space="activateRefLink($event, view.targetSlug)"
        >
          <span>{{ t("collectionsView.embedCreate") }}</span>
          <span class="material-icons text-xs">arrow_forward</span>
        </a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Ref/embed navigation goes through the binding (`navigateToRecord` + the
// optional `recordHref` for real links on router hosts) rather than a global
// `<router-link>`, so a router-less host (e.g. MulmoTerminal) can map it to its
// own view state. Translation keys resolve through the plugin's own
// `useCollectionI18n()` instance (self-contained); a host only feeds the active
// locale via `useCollectionUi().localeTag()`.
import { useCollectionI18n } from "../lang";
import { useCollectionUi } from "../scopedUi";
import { useRefLinkActivators } from "../refLink";
import type { EmbedView } from "@mulmoclaude/core/collection";

// Link activation resolves the binding at click time, so a scoped card's plain
// clicks navigate in the card's project — like the `href` beside them.
const { activateRefLink } = useRefLinkActivators();

defineProps<{ view: EmbedView; fieldKey: string }>();

const { t } = useCollectionI18n();
const cui = useCollectionUi();
</script>
