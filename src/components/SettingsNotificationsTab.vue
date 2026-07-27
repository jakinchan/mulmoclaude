<template>
  <div class="space-y-3" data-testid="settings-notifications-tab">
    <p class="text-sm text-gray-700">{{ t("settingsModal.notificationsTab.description") }}</p>

    <div class="flex items-start gap-3">
      <input
        id="settings-notifications-push-enabled"
        v-model="pushEnabled"
        type="checkbox"
        class="mt-1 h-4 w-4"
        :disabled="saving"
        data-testid="settings-notifications-push-enabled-input"
        @change="save"
      />
      <label for="settings-notifications-push-enabled" class="flex-1">
        <span class="block text-sm font-medium text-gray-800">{{ t("settingsModal.notificationsTab.enableLabel") }}</span>
        <span class="block text-xs text-gray-500 mt-0.5">{{ t("settingsModal.notificationsTab.enableHint") }}</span>
      </label>
    </div>

    <p class="text-xs text-gray-500" data-testid="settings-notifications-remote-note">{{ t("settingsModal.notificationsTab.remoteHostNote") }}</p>

    <div v-if="loaded" class="flex items-center gap-3 text-xs">
      <span :class="statusColour" data-testid="settings-notifications-status">{{ statusText }}</span>
    </div>

    <div v-if="remindersSupported" class="flex items-start gap-3 border-t border-gray-200 pt-3">
      <input
        id="settings-notifications-macos-reminders"
        v-model="remindersEnabled"
        type="checkbox"
        class="mt-1 h-4 w-4"
        :disabled="saving || remindersForcedOff"
        data-testid="settings-notifications-macos-reminders-input"
        @change="saveReminders"
      />
      <label for="settings-notifications-macos-reminders" class="flex-1">
        <span class="block text-sm font-medium text-gray-800">{{ t("settingsModal.notificationsTab.macosRemindersLabel") }}</span>
        <span class="block text-xs text-gray-500 mt-0.5">{{ t("settingsModal.notificationsTab.macosRemindersHint") }}</span>
        <span v-if="remindersForcedOff" class="block text-xs text-amber-700 mt-1" data-testid="settings-notifications-macos-reminders-forced">
          {{ t("settingsModal.notificationsTab.macosRemindersForcedOff") }}
        </span>
      </label>
    </div>

    <p v-if="errorMessage" class="text-sm text-red-700" role="alert" data-testid="settings-notifications-error">{{ errorMessage }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { apiGet, apiPut } from "../utils/api";
import { API_ROUTES } from "../config/apiRoutes";

const { t } = useI18n();

const props = defineProps<{
  /** Bumped by the parent on modal open so the toggle refetches the
   *  persisted flag (could have been hand-edited in settings.json). */
  reloadToken: number;
}>();

const emit = defineEmits<{
  saved: [];
}>();

interface SettingsResponse {
  settings: {
    extraAllowedTools: string[];
    pushEnabled?: boolean;
    macosRemindersEnabled?: boolean;
  };
  macosReminders?: { supported: boolean; forcedOffByEnv: boolean };
}

const pushEnabled = ref(false);
const stored = ref(false);
const remindersEnabled = ref(true);
const remindersStored = ref(true);
const remindersSupported = ref(false);
const remindersForcedOff = ref(false);
const loaded = ref(false);
const saving = ref(false);
const errorMessage = ref("");

const statusText = computed(() => {
  if (saving.value) return t("common.saving");
  if (errorMessage.value) return errorMessage.value;
  return stored.value ? t("settingsModal.notificationsTab.statusOn") : t("settingsModal.notificationsTab.statusOff");
});

const statusColour = computed(() => {
  if (saving.value) return "text-gray-500";
  if (errorMessage.value) return "text-red-600";
  return stored.value ? "text-green-600" : "text-gray-500";
});

async function load(): Promise<void> {
  errorMessage.value = "";
  const response = await apiGet<SettingsResponse>(API_ROUTES.config.base);
  if (!response.ok) {
    errorMessage.value = response.error || t("settingsModal.notificationsTab.loadError");
    return;
  }
  // Default false matches `isPushEnabled` in server/system/config.ts — a
  // missing field means "off", so the checkbox starts unchecked.
  const value = response.data.settings.pushEnabled ?? false;
  stored.value = value;
  pushEnabled.value = value;
  // Default true matches `isMacosRemindersEnabled` on the server — the sink
  // shipped enabled, so a settings file predating the field keeps firing.
  const reminders = response.data.settings.macosRemindersEnabled ?? true;
  remindersStored.value = reminders;
  remindersEnabled.value = reminders;
  remindersSupported.value = response.data.macosReminders?.supported ?? false;
  remindersForcedOff.value = response.data.macosReminders?.forcedOffByEnv ?? false;
  loaded.value = true;
}

async function saveReminders(): Promise<void> {
  if (saving.value) return;
  if (remindersEnabled.value === remindersStored.value) return;
  saving.value = true;
  errorMessage.value = "";
  const response = await apiPut<unknown>(API_ROUTES.config.settings, {
    macosRemindersEnabled: remindersEnabled.value,
  });
  saving.value = false;
  if (!response.ok) {
    errorMessage.value = response.error || t("settingsModal.notificationsTab.saveError");
    remindersEnabled.value = remindersStored.value;
    return;
  }
  remindersStored.value = remindersEnabled.value;
  emit("saved");
}

async function save(): Promise<void> {
  if (saving.value) return;
  if (pushEnabled.value === stored.value) return;
  saving.value = true;
  errorMessage.value = "";
  // Patch-style PUT: only `pushEnabled` is sent. The server merges it onto
  // the on-disk settings so other tabs keep their fields untouched.
  const response = await apiPut<unknown>(API_ROUTES.config.settings, {
    pushEnabled: pushEnabled.value,
  });
  saving.value = false;
  if (!response.ok) {
    errorMessage.value = response.error || t("settingsModal.notificationsTab.saveError");
    // Rollback so the visible state matches what's actually persisted.
    pushEnabled.value = stored.value;
    return;
  }
  stored.value = pushEnabled.value;
  emit("saved");
}

watch(
  () => props.reloadToken,
  () => {
    void load();
  },
  { immediate: true },
);
</script>
