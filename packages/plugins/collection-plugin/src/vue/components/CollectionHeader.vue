<template>
  <header v-if="!hideHeader" class="flex items-center gap-3 px-6 py-2 border-b border-slate-200 bg-white">
    <button
      v-if="!embedded"
      type="button"
      class="h-8 w-8 flex items-center justify-center rounded text-slate-500 hover:bg-slate-50 hover:text-slate-800 transition-colors"
      :title="t('collectionsView.backToIndex')"
      :aria-label="t('collectionsView.backToIndex')"
      data-testid="collections-back"
      @click="$emit('back')"
    >
      <span class="material-icons text-lg">arrow_back</span>
    </button>

    <div v-if="collection" class="h-9 w-9 flex items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100">
      <span class="material-symbols-outlined text-xl">{{ collection.icon }}</span>
    </div>

    <div class="flex-1 min-w-0">
      <h1 class="text-base font-bold text-slate-800 truncate">
        {{ collection?.title ?? t("collectionsView.title") }}
      </h1>
      <span v-if="collection" class="block text-[10px] text-slate-400 font-bold uppercase tracking-wider truncate">
        {{ collection.slug }}
        <!-- dataSource chip: sets the read-only expectation up front and
             links to the file that IS the data (the one editable thing). -->
        <template v-if="isReadOnly">
          <span
            class="inline-flex items-center gap-0.5 ml-1.5 px-1.5 py-px rounded bg-amber-50 text-amber-700 border border-amber-200 normal-case tracking-normal"
            data-testid="collections-readonly-chip"
          >
            <span class="material-icons text-[11px]">lock</span>
            {{ t("collectionsView.readonlyChip") }}
          </span>
          <a
            v-if="dataSourceRoute"
            :href="dataSourceRoute ?? undefined"
            class="ml-1 normal-case tracking-normal font-mono font-normal text-slate-500 hover:text-indigo-700 hover:underline"
            data-testid="collections-readonly-source"
            @click="activatePathLink($event, dataSourceRoute ?? '', true)"
            >{{ collection.schema.dataSource?.path }}</a
          >
        </template>
      </span>
    </div>

    <component
      :is="pinToggle"
      v-if="collection && !embedded"
      :kind="isFeedRoute ? 'feed' : 'collection'"
      :slug="collection.slug"
      :title="collection.title"
      :icon="collection.icon"
    />

    <button
      v-if="refreshLabel"
      type="button"
      class="h-8 px-2.5 flex items-center gap-1 rounded border border-indigo-200 bg-white hover:bg-indigo-50 text-indigo-600 font-bold text-xs transition-colors disabled:opacity-50"
      :disabled="refreshing"
      data-testid="collections-refresh-feed"
      @click="$emit('refreshFeed')"
    >
      <span class="material-icons text-sm">{{ refreshing ? "hourglass_empty" : "refresh" }}</span>
      <span>{{ refreshLabel }}</span>
    </button>

    <button
      v-if="collection?.schema?.googleCalendar"
      type="button"
      class="h-8 px-2.5 flex items-center gap-1 rounded border border-indigo-200 bg-white hover:bg-indigo-50 text-indigo-600 font-bold text-xs transition-colors disabled:opacity-50"
      :disabled="pushing"
      data-testid="collections-push-calendar"
      @click="$emit('pushCalendar')"
    >
      <span class="material-icons text-sm">{{ pushing ? "hourglass_empty" : "upload" }}</span>
      <span>{{ t("collectionsView.pushCalendar") }}</span>
    </button>

    <button
      v-if="collection"
      type="button"
      class="h-8 px-2.5 flex items-center gap-1 rounded border border-indigo-200 bg-white hover:bg-indigo-50 text-indigo-600 font-bold text-xs transition-colors"
      data-testid="collections-chat"
      @click="$emit('openChat')"
    >
      <span class="material-icons text-sm">forum</span>
      <span>{{ t("collectionsView.chat") }}</span>
    </button>

    <!-- Related-collections pulldown: one click to hop to a collection this
         one links to (its refs) or that links back (their refs/backlinks).
         Standalone only, and only when the host exposes `fetchOntology` — a
         host without that capability (MulmoTerminal) simply omits the
         control, the same additive pattern as the index Map tab. Neighbors
         are derived lazily on first open (the ontology scan is expensive and
         most view opens never touch this menu). -->
    <div v-if="showRelatedMenu" ref="relatedMenuRef" class="relative">
      <button
        type="button"
        class="h-8 px-2.5 flex items-center gap-1 rounded border border-indigo-200 bg-white hover:bg-indigo-50 text-indigo-600 font-bold text-xs transition-colors"
        :aria-expanded="relatedMenuOpen"
        data-testid="collections-related-menu"
        @click="toggleRelatedMenu"
      >
        <span class="material-icons text-sm">hub</span>
        <span>{{ t("collectionsView.related") }}</span>
      </button>
      <div
        v-if="relatedMenuOpen"
        class="absolute right-0 top-full mt-1 z-20 min-w-max rounded border border-slate-200 bg-white shadow-lg py-1"
        data-testid="collections-related-menu-panel"
      >
        <!-- In-flight: the ontology fetch backing this open. -->
        <div v-if="relatedLoading" class="w-full h-8 px-3 flex items-center gap-2 text-xs text-slate-400" data-testid="collections-related-loading">
          <span class="material-icons text-sm animate-spin">hourglass_empty</span>
          <span>{{ t("common.loading") }}</span>
        </div>
        <!-- Fail-soft: a failed fetch or a collection with no relations both
             land on the same disabled empty-state row (no error toast). -->
        <div v-else-if="relatedItems.length === 0" class="w-full h-8 px-3 flex items-center text-xs text-slate-400" data-testid="collections-related-empty">
          {{ t("collectionsView.relatedEmpty") }}
        </div>
        <button
          v-for="related in relatedItems"
          :key="related.slug"
          type="button"
          class="w-full h-8 px-3 flex items-center gap-2 text-xs text-slate-600 hover:bg-slate-50 transition-colors"
          :data-testid="`collections-related-item-${related.slug}`"
          @click="gotoRelated(related.slug)"
        >
          <span class="material-symbols-outlined text-base">{{ related.icon }}</span>
          <span class="flex-1 text-left">{{ related.title }}</span>
          <span
            class="material-icons text-sm text-slate-400"
            :title="relatedDirectionLabel(related.direction)"
            :aria-label="relatedDirectionLabel(related.direction)"
            role="img"
            >{{ relatedDirectionIcon(related.direction) }}</span
          >
        </button>
      </div>
    </div>

    <!-- Collection-level actions (schema `collectionActions`). No record
         context: each seeds a chat with a progress summary of all items. -->
    <button
      v-for="action in collectionActions"
      :key="action.id"
      type="button"
      class="h-8 px-2.5 flex items-center gap-1 rounded border border-indigo-200 bg-white hover:bg-indigo-50 text-indigo-600 font-bold text-xs transition-colors disabled:opacity-50"
      :disabled="collectionActionPending || isActionRunning(action.id)"
      :data-testid="`collections-action-${action.id}`"
      @click="$emit('runCollectionAction', action)"
    >
      <!-- A running `kind:"agent"` worker replaces the icon with a spinner
           until the completion ping's refetch clears its run key. -->
      <span v-if="isActionRunning(action.id)" class="material-symbols-outlined text-sm animate-spin">progress_activity</span>
      <span v-else-if="action.icon" class="material-symbols-outlined text-sm">{{ action.icon }}</span>
      <span>{{ action.label }}</span>
    </button>

    <!-- Hidden in calendar view: there, creation happens via the day view's
         + button, which opens the new-item form in the popup's right pane. -->
    <button
      v-if="canCreate && !calendarActive"
      type="button"
      class="h-8 px-2.5 flex items-center gap-1 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs transition-colors shadow-sm"
      data-testid="collections-add-item"
      @click="$emit('openCreate')"
    >
      <span class="material-icons text-sm">add</span>
      <span>{{ t("common.add") }}</span>
    </button>

    <button
      v-if="canDeleteCollection && !embedded"
      type="button"
      class="h-8 w-8 flex items-center justify-center rounded border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 transition-colors"
      :title="t('collectionsView.deleteCollection')"
      :aria-label="t('collectionsView.deleteCollection')"
      data-testid="collections-delete"
      @click="$emit('confirmCollectionDelete')"
    >
      <span class="material-icons text-sm">delete_forever</span>
    </button>

    <button
      v-if="canDeleteFeed && !embedded"
      type="button"
      class="h-8 w-8 flex items-center justify-center rounded border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 transition-colors"
      :title="t('collectionsView.deleteFeed')"
      :aria-label="t('collectionsView.deleteFeed')"
      data-testid="feeds-delete"
      @click="$emit('confirmFeedDelete')"
    >
      <span class="material-icons text-sm">delete_forever</span>
    </button>
  </header>
</template>

<script setup lang="ts">
// The collection view's top header (back / title + dataSource chip / pin /
// refresh-feed / chat / related-menu / collection actions / add / delete),
// extracted from CollectionView so that file stays an orchestrator (#2528).
//
// The related-collections pulldown lives ENTIRELY inside this header, so its
// `useRelatedMenu` (open-state + click-outside ref + lazy ontology fetch) moves
// here too — the wrapper ref, trigger and panel then sit in one component and
// the document-level outside-click listener resolves against a ref this
// component owns, exactly as before. The parent drives the per-slug reset
// through the exposed `resetForSlugChange`, keeping its original timing.
import { computed, toRef } from "vue";
import { useCollectionI18n } from "../lang";
import { collectionUi } from "../uiContext";
import { useRelatedMenu } from "../composables/useRelatedMenu";
import { activatePathLink } from "../refLink";
import { agentActionRunKey, type CollectionAction, type CollectionDetail } from "@mulmoclaude/core/collection";

const props = defineProps<{
  collection: CollectionDetail | null;
  embedded: boolean;
  hideHeader: boolean;
  isReadOnly: boolean;
  dataSourceRoute: string | null;
  isFeedRoute: boolean;
  refreshing: boolean;
  pushing: boolean;
  collectionActions: CollectionAction[];
  collectionActionPending: boolean;
  runningActionIds: Set<string>;
  canCreate: boolean;
  calendarActive: boolean;
  canDeleteCollection: boolean;
  canDeleteFeed: boolean;
}>();

defineEmits<{
  back: [];
  refreshFeed: [];
  pushCalendar: [];
  openChat: [];
  runCollectionAction: [action: CollectionAction];
  openCreate: [];
  confirmCollectionDelete: [];
  confirmFeedDelete: [];
}>();

const { t } = useCollectionI18n();
const cui = collectionUi();
const { pinToggle } = cui;

const {
  relatedMenuOpen,
  relatedMenuRef,
  relatedLoading,
  showRelatedMenu,
  relatedItems,
  toggleRelatedMenu,
  gotoRelated,
  relatedDirectionIcon,
  relatedDirectionLabel,
  resetForSlugChange,
} = useRelatedMenu({ collection: toRef(props, "collection"), embedded: toRef(props, "embedded"), cui, t });

/** The Refresh button's label, or null when the collection has nothing to
 *  re-run. A `googleCalendar` collection syncs on the same button but says so
 *  (#2427); `ingest` wins if a schema declares both, matching the route. */
const refreshLabel = computed<string | null>(() => {
  const schema = props.collection?.schema;
  if (schema?.ingest) return t("collectionsView.refreshFeed");
  if (schema?.googleCalendar) return t("collectionsView.syncCalendar");
  return null;
});

/** Header buttons only ever check the collection-level run key (no itemId),
 *  so this mirrors the parent's `isActionRunning(id)` via the same key builder. */
const isActionRunning = (actionId: string): boolean => props.runningActionIds.has(agentActionRunKey(actionId));

defineExpose({ resetForSlugChange });
</script>
