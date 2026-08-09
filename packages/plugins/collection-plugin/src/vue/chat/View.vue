<template>
  <div class="w-full h-full" data-testid="present-collection">
    <CollectionView
      v-if="slug"
      :slug="slug"
      :selected="selected"
      :initial-view="viewState?.view"
      :initial-anchor-field="viewState?.anchorField"
      :initial-group-field="viewState?.groupField"
      :send-text-message="sendTextMessage"
      @select="onSelect"
      @view-state-change="onViewStateChange"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ToolResult } from "gui-chat-protocol";
import CollectionView from "../components/CollectionView.vue";
import type { PresentCollectionData } from "@mulmoclaude/core/collection";
import { toPresentCollectionData } from "./presentCollectionData";
import { provideCollectionScope } from "../scopedUi";

/** Card-local UI state persisted in the tool result's `viewState` so it
 *  survives a re-render — same pattern as presentForm. `selected` is the
 *  open record (`null` once explicitly closed); `view` / `anchorField` /
 *  `groupField` keep the table↔calendar↔kanban choice and its axes sticky.
 *  NOTE: the table sort is deliberately NOT here — it's a single shared
 *  per-collection preference in localStorage (read+written by both the
 *  standalone page and chat cards), so it stays consistent everywhere. */
interface PresentCollectionViewState {
  selected?: string | null;
  view?: "table" | "calendar" | "kanban";
  anchorField?: string;
  groupField?: string;
}

const props = defineProps<{
  selectedResult: ToolResult | null;
  /** Host-provided channel into the current chat session. Forwarded to
   *  CollectionView so its chat actions send a message here instead of
   *  spawning a new chat (the card is always rendered inside a chat). */
  sendTextMessage?: (text?: string) => void;
}>();

const emit = defineEmits<{
  updateResult: [result: ToolResult];
}>();

const data = computed<PresentCollectionData | null>(() => toPresentCollectionData(props.selectedResult?.data ?? props.selectedResult?.jsonData));

const slug = computed<string | undefined>(() => data.value?.collectionSlug);

// A collection's identity is (root, slug), and this card names both: the host
// stamped the project it was made in onto the payload. Bind the card's subtree
// to it so its fetches address THAT project rather than whichever one happens to
// be ambient when the card renders. Absent — the single-workspace case, and every
// card produced before the field existed — this is the global binding, unchanged.
provideCollectionScope(() => data.value?.scope);

/** Keep a field only when the stored value still matches what the interface
 *  declares, so `"selected" in state` keeps meaning "the user navigated". */
function toViewState(value: unknown): PresentCollectionViewState | null {
  if (typeof value !== "object" || value === null) return null;
  const state: PresentCollectionViewState = {};
  if ("selected" in value && (typeof value.selected === "string" || value.selected === null)) state.selected = value.selected;
  if ("view" in value && (value.view === "table" || value.view === "calendar" || value.view === "kanban")) state.view = value.view;
  if ("anchorField" in value && typeof value.anchorField === "string") state.anchorField = value.anchorField;
  if ("groupField" in value && typeof value.groupField === "string") state.groupField = value.groupField;
  return state;
}

const viewState = computed<PresentCollectionViewState | null>(() => toViewState(props.selectedResult?.viewState));

/** Open record: the card-local `viewState.selected` once the user has
 *  navigated within the card (including an explicit close → null), else
 *  the tool's initial `itemId`. */
const selected = computed<string | undefined>(() => {
  const state = viewState.value;
  if (state && "selected" in state) return state.selected ?? undefined;
  return data.value?.itemId;
});

function onSelect(itemId: string | null): void {
  if (!props.selectedResult) return;
  emit("updateResult", { ...props.selectedResult, viewState: { ...viewState.value, selected: itemId } });
}

function onViewStateChange(state: { view: "table" | "calendar" | "kanban"; anchorField: string; groupField: string }): void {
  if (!props.selectedResult) return;
  // Skip redundant writes (the anchor/group settling on load fires this once).
  const current = viewState.value;
  if (current?.view === state.view && current?.anchorField === state.anchorField && current?.groupField === state.groupField) return;
  emit("updateResult", {
    ...props.selectedResult,
    viewState: { ...current, view: state.view, anchorField: state.anchorField, groupField: state.groupField },
  });
}
</script>
