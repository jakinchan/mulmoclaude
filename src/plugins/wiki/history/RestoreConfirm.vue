<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { formatSmartTime } from "../../../utils/format/date";
import type { SnapshotSummary } from "./api";

const props = defineProps<{
  snapshot: SnapshotSummary;
  /** True while the parent's POST is in flight; disables both
   *  buttons and surfaces a spinner on the action button. */
  restoring: boolean;
}>();

const emit = defineEmits<{
  cancel: [];
  confirm: [];
}>();

const { t } = useI18n();

function editorLabel(editor: SnapshotSummary["editor"]): string {
  if (editor === "llm") return t("pluginWiki.history.editorBadgeLLM");
  if (editor === "system") return t("pluginWiki.history.editorBadgeSystem");
  return t("pluginWiki.history.editorBadgeUser");
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
    data-testid="wiki-history-restore-confirm"
    @click.self="!restoring && emit('cancel')"
  >
    <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-5">
      <h3 class="text-lg font-semibold text-gray-800 mb-3">
        {{ t("pluginWiki.history.restoreConfirmTitle") }}
      </h3>
      <p class="text-sm text-gray-700 leading-relaxed">
        {{ t("pluginWiki.history.restoreConfirmBody", { ts: formatSmartTime(props.snapshot.ts), editor: editorLabel(props.snapshot.editor) }) }}
      </p>
      <div class="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          class="h-8 px-3 rounded text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          :disabled="restoring"
          data-testid="wiki-history-restore-cancel"
          @click="emit('cancel')"
        >
          {{ t("pluginWiki.history.restoreConfirmCancel") }}
        </button>
        <button
          type="button"
          class="h-8 px-3 rounded text-sm bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
          :disabled="restoring"
          data-testid="wiki-history-restore-confirm-action"
          @click="emit('confirm')"
        >
          <span v-if="restoring" class="material-symbols-outlined text-base animate-spin">progress_activity</span>
          {{ t("pluginWiki.history.restoreConfirmAction") }}
        </button>
      </div>
    </div>
  </div>
</template>
