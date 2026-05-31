<template>
  <div class="w-full h-full" data-testid="present-collection">
    <CollectionView v-if="slug" :slug="slug" :selected="selected" :send-text-message="sendTextMessage" @select="onSelect" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ToolResult } from "gui-chat-protocol";
import CollectionView from "../../components/CollectionView.vue";
import type { PresentCollectionData } from "./types";

/** Card-local UI state: which record the user has opened within the
 *  card. Persisted in the tool result's `viewState` so the open item
 *  survives a re-render — same pattern as presentForm. `null` once the
 *  user has explicitly closed the detail view. */
interface PresentCollectionViewState {
  selected?: string | null;
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

const data = computed<PresentCollectionData | null>(
  () => (props.selectedResult?.data ?? props.selectedResult?.jsonData ?? null) as PresentCollectionData | null,
);

const slug = computed<string | undefined>(() => data.value?.collectionSlug);

const viewState = computed<PresentCollectionViewState | null>(() => (props.selectedResult?.viewState as PresentCollectionViewState | undefined) ?? null);

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
  emit("updateResult", { ...props.selectedResult, viewState: { selected: itemId } });
}
</script>
