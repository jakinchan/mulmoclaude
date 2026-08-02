<template>
  <div class="space-y-3" data-testid="settings-map-tab">
    <p class="text-sm text-gray-700">{{ t("settingsModal.mapTab.description") }}</p>

    <div class="space-y-2">
      <label class="block text-sm font-medium text-gray-800" for="settings-map-api-key">{{ t("settingsModal.mapTab.apiKeyLabel") }}</label>
      <input
        id="settings-map-api-key"
        v-model="apiKeyDraft"
        type="password"
        autocomplete="off"
        spellcheck="false"
        class="w-full px-3 py-2 text-sm font-mono rounded border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
        :placeholder="t('settingsModal.mapTab.apiKeyPlaceholder')"
        :disabled="loading"
        data-testid="settings-map-api-key-input"
        @blur="save"
        @keydown.enter.prevent="onEnterKey"
      />
      <p class="text-xs text-gray-500">
        <i18n-t keypath="settingsModal.mapTab.helperText" tag="span">
          <template #consoleLink>
            <!-- eslint-disable @intlify/vue-i18n/no-raw-text -- "Google Cloud Console" is a product name, not translatable copy -->
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline"
              >Google Cloud Console</a
            >
            <!-- eslint-enable @intlify/vue-i18n/no-raw-text -->
          </template>
        </i18n-t>
      </p>
      <p class="text-xs text-gray-500">{{ t("settingsModal.mapTab.requiredApis") }}</p>
    </div>

    <div v-if="loaded" class="flex items-center gap-3 text-xs">
      <span :class="statusColour" data-testid="settings-map-status">
        {{ statusText }}
      </span>
    </div>

    <p v-if="errorMessage" class="text-sm text-red-700" role="alert" data-testid="settings-map-error">{{ errorMessage }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { apiGet, apiPut } from "../utils/api";
import { API_ROUTES } from "../config/apiRoutes";

const { t } = useI18n();

const props = defineProps<{
  /** Bumped by the parent each time the modal opens so the input
   *  reflects any out-of-band edit (settings.json hand-edit, save
   *  from another window, etc.). */
  reloadToken: number;
}>();

const emit = defineEmits<{
  saved: [];
}>();

interface SettingsResponse {
  settings: { extraAllowedTools: string[]; googleMapsApiKey?: string };
}

const apiKeyDraft = ref("");
const storedKey = ref("");
// The field stays disabled until the stored key has arrived: a load that
// resolves after the user started typing would overwrite the draft, and the
// save that follows then sees no change and silently does nothing.
const loading = ref(true);
const loaded = ref(false);
const saving = ref(false);
const errorMessage = ref("");

// Auto-save fires on blur OR Enter. Pattern matches the other auto-
// saving tabs (Workspace Dirs / Reference Dirs / MCP) — no Save
// button, no Cancel button. Clearing the input + losing focus
// equivalently clears the stored key.

const statusText = computed(() => {
  if (saving.value) return t("common.saving");
  if (errorMessage.value) return errorMessage.value;
  return storedKey.value ? t("settingsModal.mapTab.configured") : t("settingsModal.mapTab.notConfigured");
});

const statusColour = computed(() => {
  if (saving.value) return "text-gray-500";
  if (errorMessage.value) return "text-red-600";
  return storedKey.value ? "text-green-600" : "text-gray-500";
});

async function load(): Promise<void> {
  errorMessage.value = "";
  loading.value = true;
  const response = await apiGet<SettingsResponse>(API_ROUTES.config.base);
  loading.value = false;
  if (!response.ok) {
    errorMessage.value = response.error || t("settingsModal.mapTab.loadError");
    return;
  }
  storedKey.value = response.data.settings.googleMapsApiKey ?? "";
  apiKeyDraft.value = storedKey.value;
  loaded.value = true;
}

// Save handler used by both `@blur` and `@keydown.enter`. No-ops
// when nothing changed (the user just tabbed in and out without
// typing) so the network round-trip is skipped.
async function save(): Promise<void> {
  if (saving.value) return;
  const trimmed = apiKeyDraft.value.trim();
  if (trimmed === storedKey.value) return;
  saving.value = true;
  errorMessage.value = "";
  // Patch-style PUT: only `googleMapsApiKey` is sent. The server's
  // /api/config/settings handler merges over the on-disk state,
  // so other tabs' fields (extraAllowedTools) survive untouched.
  // Empty string is a valid "clear" operation.
  const response = await apiPut<unknown>(API_ROUTES.config.settings, {
    googleMapsApiKey: trimmed,
  });
  saving.value = false;
  if (!response.ok) {
    errorMessage.value = response.error || t("settingsModal.mapTab.saveError");
    return;
  }
  storedKey.value = trimmed;
  apiKeyDraft.value = trimmed;
  emit("saved");
}

// Enter key: commit immediately + drop focus so the visible state
// transitions to "Configured" without a second tab press.
function onEnterKey(event: Event): void {
  const { target } = event;
  if (target instanceof HTMLElement) target.blur();
}

watch(
  () => props.reloadToken,
  () => {
    void load();
  },
  { immediate: true },
);
</script>
