<template>
  <div class="space-y-3" data-testid="settings-quit-tab">
    <p class="text-sm text-gray-700">{{ t("settingsModal.quitTab.description") }}</p>
    <p class="text-xs text-gray-500">{{ t("settingsModal.quitTab.restartHint") }}</p>

    <div v-if="!confirming" class="pt-1">
      <button
        type="button"
        class="rounded border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
        :disabled="stopping"
        data-testid="settings-quit-btn"
        @click="confirming = true"
      >
        {{ t("settingsModal.quitTab.quitLabel") }}
      </button>
    </div>

    <div v-else class="rounded border border-red-200 bg-red-50 p-3 space-y-2" data-testid="settings-quit-confirm">
      <p class="text-sm text-red-900">{{ t("settingsModal.quitTab.confirmBody") }}</p>
      <div class="flex gap-2">
        <button
          type="button"
          class="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
          :disabled="stopping"
          data-testid="settings-quit-confirm-btn"
          @click="quit"
        >
          {{ stopping ? t("settingsModal.quitTab.stopping") : t("settingsModal.quitTab.confirmLabel") }}
        </button>
        <button
          type="button"
          class="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          :disabled="stopping"
          data-testid="settings-quit-cancel-btn"
          @click="confirming = false"
        >
          {{ t("common.cancel") }}
        </button>
      </div>
    </div>

    <p v-if="errorMessage" class="text-sm text-red-700" role="alert" data-testid="settings-quit-error">{{ errorMessage }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { apiPost } from "../utils/api";
import { API_ROUTES } from "../config/apiRoutes";

const { t } = useI18n();

const emit = defineEmits<{
  stopped: [];
}>();

const confirming = ref(false);
const stopping = ref(false);
const errorMessage = ref("");

async function quit(): Promise<void> {
  if (stopping.value) return;
  stopping.value = true;
  errorMessage.value = "";
  // The server answers BEFORE it stops (see server/api/routes/shutdown.ts),
  // so this response is the signal to switch the whole page over. Waiting
  // for the socket to die instead would leave the user staring at a live
  // app that is about to vanish.
  const response = await apiPost<{ stopping: boolean }>(API_ROUTES.shutdown, {});
  if (!response.ok) {
    stopping.value = false;
    confirming.value = false;
    errorMessage.value = response.error || t("settingsModal.quitTab.error");
    return;
  }
  emit("stopped");
}
</script>
