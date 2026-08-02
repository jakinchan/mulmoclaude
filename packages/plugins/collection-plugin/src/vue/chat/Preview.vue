<template>
  <div class="w-full h-full flex flex-col items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-50 rounded-lg border-2 border-gray-200">
    <div class="text-center">
      <span class="material-icons text-4xl text-indigo-600 mb-2">collections_bookmark</span>
      <h3 class="text-gray-900 font-bold text-lg mb-1 line-clamp-2">
        {{ collectionSlug || t("pluginPresentCollection.fallbackTitle") }}
      </h3>
      <p v-if="itemId" class="text-gray-600 text-sm">{{ t("pluginPresentCollection.itemLabel", { id: itemId }) }}</p>
      <p v-else class="text-gray-500 text-sm">{{ t("pluginPresentCollection.listLabel") }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useCollectionI18n } from "../lang";
import type { ToolResult } from "gui-chat-protocol";
import type { PresentCollectionData } from "@mulmoclaude/core/collection";
import { toPresentCollectionData } from "./presentCollectionData";

const { t } = useCollectionI18n();

const props = defineProps<{
  result: ToolResult;
}>();

const data = computed<PresentCollectionData | null>(() => toPresentCollectionData(props.result?.data ?? props.result?.jsonData));

const collectionSlug = computed<string>(() => data.value?.collectionSlug ?? "");
const itemId = computed<string | undefined>(() => data.value?.itemId);
</script>
