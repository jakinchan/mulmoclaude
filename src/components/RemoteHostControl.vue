<template>
  <div ref="rootRef" class="relative">
    <button
      type="button"
      class="relative h-8 w-8 flex items-center justify-center rounded hover:text-gray-700"
      :class="status.connected ? 'text-green-600' : 'text-gray-400'"
      data-testid="remote-host-btn"
      :title="t('remoteHost.title')"
      :aria-label="t('remoteHost.title')"
      @click="toggle"
    >
      <span class="material-icons">phonelink</span>
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50 p-3 text-xs"
      data-testid="remote-host-popover"
    >
      <div class="flex items-center gap-1.5 mb-2">
        <span class="material-icons text-[14px]" :class="status.connected ? 'text-green-600' : 'text-gray-400'">
          {{ status.connected ? "check_circle" : "radio_button_unchecked" }}
        </span>
        <span class="font-medium text-gray-800">{{ status.connected ? t("remoteHost.online") : t("remoteHost.offline") }}</span>
      </div>

      <p v-if="status.uid" class="text-gray-500 break-all mb-2" data-testid="remote-host-uid">{{ t("remoteHost.uid", { uid: status.uid }) }}</p>

      <div class="flex flex-col gap-1">
        <button
          v-if="!status.connected"
          type="button"
          class="h-8 flex items-center justify-center gap-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="remote-host-connect-btn"
          :disabled="busy"
          @click="onConnect"
        >
          <span class="material-icons text-[16px]">login</span>
          {{ busy ? t("remoteHost.connecting") : t("remoteHost.signIn") }}
        </button>
        <button
          v-else
          type="button"
          class="h-8 flex items-center justify-center gap-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="remote-host-disconnect-btn"
          :disabled="busy"
          @click="onDisconnect"
        >
          <span class="material-icons text-[16px]">logout</span>
          {{ busy ? t("remoteHost.disconnecting") : t("remoteHost.disconnect") }}
        </button>
      </div>

      <p v-if="error" class="mt-2 text-red-600 break-words" data-testid="remote-host-error">{{ error }}</p>

      <div class="mt-3 pt-2 border-t border-gray-100 text-[11px] leading-snug text-gray-600 space-y-2" data-testid="remote-host-help">
        <p>{{ t("remoteHost.description") }}</p>
        <i18n-t keypath="remoteHost.customViewHint" tag="p" scope="global">
          <template #keyword>
            <code class="px-1 py-0.5 rounded bg-gray-100 text-gray-800">custom remote view</code>
          </template>
        </i18n-t>
        <i18n-t keypath="remoteHost.howTo" tag="p" scope="global">
          <template #url>
            <a :href="MOBILE_URL" target="_blank" rel="noopener noreferrer" class="font-mono text-blue-600 hover:underline break-all">{{ MOBILE_URL }}</a>
          </template>
        </i18n-t>
        <div class="flex flex-col items-center gap-1 pt-1">
          <img :src="qrDataUrl" alt="" aria-hidden="true" class="h-32 w-32" data-testid="remote-host-qr" />
          <p>{{ t("remoteHost.qrHint") }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Toolbar control for the remote-host command channel (phase 1).
//
// Connection state, presence polling, and auto-reconnect live in the shared
// `useRemoteHost` store so the offline banner sees the same state; this component
// owns only the popover + QR. Google sign-in popup → idToken → POST /connect,
// where the server starts the Firestore command loop + presence heartbeat.
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { renderSVG } from "uqr";

import { useRemoteHost } from "../composables/useRemoteHost";
import { eventTargetNode } from "../utils/dom/eventTarget";

const { t } = useI18n();
const { status, error, busy, connect, disconnect, refreshStatus, startWatching, stopWatching } = useRemoteHost();

// Mobile companion PWA. Shown in the popover as help text; not fetched from
// this desktop app, so no runtime env override is needed.
const MOBILE_URL = "https://mulmoserver.web.app";
// Rendered to a data URL (uqr output is ASCII-only SVG) so no v-html is needed.
const qrDataUrl = `data:image/svg+xml;base64,${btoa(renderSVG(MOBILE_URL))}`;

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);

const toggle = () => {
  open.value = !open.value;
  if (open.value) void refreshStatus();
};

const onConnect = async () => {
  await connect();
  if (status.value.connected) open.value = false; // close the popover after a successful login
};

const onDisconnect = async () => {
  await disconnect();
  if (!status.value.connected) open.value = false; // close the popover after a successful logout
};

const onDocumentClick = (event: MouseEvent) => {
  if (!open.value) return;
  const target = eventTargetNode(event);
  if (rootRef.value && target && !rootRef.value.contains(target)) open.value = false;
};

onMounted(() => {
  startWatching();
  document.addEventListener("mousedown", onDocumentClick);
});
onBeforeUnmount(() => {
  stopWatching();
  document.removeEventListener("mousedown", onDocumentClick);
});
</script>
