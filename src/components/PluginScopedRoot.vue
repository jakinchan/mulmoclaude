<script setup lang="ts">
// Scope-provider wrapper for runtime plugin Vue components (#1110).
// Builds a per-plugin BrowserPluginRuntime and `provide`s it under
// PLUGIN_RUNTIME_KEY, so plugin descendants can pull it via
// `useRuntime()` from `gui-chat-protocol/vue`.
//
// One instance per mounted plugin component subtree. Mount this in
// the host's runtime plugin loader (the place that dynamically
// imports the plugin's `dist/vue.js` and instantiates its
// `viewComponent` / `previewComponent`).
//
// Doubles as the per-plugin error boundary: a Vue `errorCaptured`
// hook catches uncaught errors thrown during the plugin subtree's
// render / setup / lifecycle and renders a fallback panel instead
// of letting the exception break out and unmount the whole chat
// canvas. One bad plugin should fail in place, not take the host
// with it. The captured error is logged to the console; the user
// sees a "crashed" panel with optional stack details and a Retry
// button that re-mounts the plugin.

import { onErrorCaptured, provide } from "vue";
import { useI18n } from "vue-i18n";
import { PLUGIN_RUNTIME_KEY } from "gui-chat-protocol/vue";
import { makeBrowserPluginRuntime } from "../utils/plugin/runtime";
import { usePluginErrorBoundary } from "../composables/usePluginErrorBoundary";

interface Props {
  /** npm package name of the plugin whose subtree we're scoping. */
  pkgName: string;
  /** Optional URL map exposed to the plugin via `runtime.endpoints`.
   *  Multi-URL built-in plugins (todos, scheduler, mulmoScript, …)
   *  pass their endpoint group ({ method, url } records since #1141);
   *  runtime-loaded plugins (the common single-dispatch shape) omit
   *  this AND host-shared scopes (`files`, `imageStore`, `mcpTools`)
   *  pass plain string URLs. Treated opaquely here — each consumer
   *  asserts the shape it expects via `pluginEndpoints<E>(scope)`.
   *  Contract: `gui-chat-protocol@>=0.3.1`. */
  endpoints?: Readonly<Record<string, unknown>> | undefined;
}

const props = defineProps<Props>();

const { t } = useI18n();

// Construct once — `pkgName` and `endpoints` are fixed for the
// lifetime of a mounted plugin. If the host needs to rotate the
// scope (rare), it should remount the entire wrapper rather than
// mutate either prop.
const runtime = makeBrowserPluginRuntime({ pkgName: props.pkgName, endpoints: props.endpoints });
provide(PLUGIN_RUNTIME_KEY, runtime);

// ── Error boundary state ────────────────────────────────────────
//
// State + reset logic live in `usePluginErrorBoundary` (testable
// without a DOM). The Vue lifecycle hook `onErrorCaptured` itself
// must be wired here — the composable can't call `setup()`-only
// hooks. Returning `false` from the hook tells Vue we've handled
// the error; without it, the exception propagates to the parent
// and ultimately to the global error handler.
const { error, showDetails, mountKey, errorDetails, captureError, retry } = usePluginErrorBoundary(props.pkgName);
onErrorCaptured((err) => {
  captureError(err);
  return false;
});
</script>

<template>
  <div v-if="error" class="rounded border border-red-200 bg-red-50 p-3 text-sm" data-testid="plugin-error-boundary" role="alert">
    <div class="flex items-center gap-2 mb-1">
      <span class="material-icons text-red-500" aria-hidden="true">error_outline</span>
      <span class="font-medium text-red-800">{{ t("pluginErrorBoundary.title", { pkg: pkgName }) }}</span>
    </div>
    <p class="text-red-700 mb-2">{{ t("pluginErrorBoundary.subtitle") }}</p>
    <div class="flex items-center gap-3">
      <button type="button" class="text-xs text-red-600 hover:underline" data-testid="plugin-error-toggle-details" @click="showDetails = !showDetails">
        {{ showDetails ? t("pluginErrorBoundary.hideDetails") : t("pluginErrorBoundary.showDetails") }}
      </button>
      <button type="button" class="text-xs text-red-600 hover:underline" data-testid="plugin-error-retry" @click="retry">
        {{ t("pluginErrorBoundary.retry") }}
      </button>
    </div>
    <pre v-if="showDetails" class="mt-2 text-xs text-red-900 bg-red-100 p-2 rounded overflow-auto max-h-40 whitespace-pre-wrap break-words">{{
      errorDetails
    }}</pre>
  </div>
  <slot v-else :key="mountKey" />
</template>
