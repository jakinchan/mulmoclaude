<template>
  <div class="custom-view-container">
    <div v-if="error" class="custom-view-message" role="alert" data-testid="collection-custom-view-error">
      {{ t("collectionsView.customViewError", { error }) }}
    </div>
    <div v-else-if="loading" class="custom-view-message" data-testid="collection-custom-view-loading">
      {{ t("collectionsView.customViewLoading") }}
    </div>
    <!-- Sandboxed: NO `allow-same-origin`, so the view keeps an opaque origin
         and cannot read the parent's token / localStorage — its data reaches it
         only via the scoped token injected into __MC_VIEW. `allow-popups` +
         `allow-popups-to-escape-sandbox` let a view open an external link
         (`<a target="_blank">` / `window.open`) as a normal new tab — e.g. a
         feed card linking to its article. Opening requires a user gesture and
         `target="_blank"` defaults to `noopener`, so the popup can't reach back
         into the view; the token stays isolated. `allow-downloads` lets a view
         save files (e.g. an .ics iCalendar export) — without it the browser
         silently blocks any download the frame initiates. -->
    <iframe
      v-else-if="srcdoc"
      ref="iframeEl"
      :key="view.id"
      data-testid="collection-custom-view-iframe"
      :title="view.label"
      :srcdoc="srcdoc"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads"
      class="w-full h-full border-0"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { useCollectionI18n } from "../lang";
import { errorMessage } from "@mulmoclaude/core/collection";
import type { CollectionCustomView } from "@mulmoclaude/core/collection";
import { collectionUi } from "../uiContext";

const { t } = useCollectionI18n();

const props = defineProps<{
  slug: string;
  view: CollectionCustomView;
}>();

const emit = defineEmits<{
  /** The view called `__MC_VIEW.openItem(id, mode)` — open the record in the
   *  host's shared modal. */
  openItem: [payload: { id: string; mode: "view" | "edit" }];
  /** The view called `__MC_VIEW.startChat(prompt, role)` — open a new chat with
   *  `prompt` prefilled as an editable draft (host validates `role`). */
  startChat: [payload: { prompt: string; role?: string | undefined }];
}>();

const loading = ref(true);
const error = ref<string | null>(null);
const srcdoc = ref<string | null>(null);
const iframeEl = ref<HTMLIFrameElement | null>(null);

// The injected token expires (VIEW_TOKEN_TTL_MS, 1h). The sandboxed view can't
// re-mint itself (it has no global bearer), so a view left mounted past expiry
// would 401 on its next read/write. Schedule a re-mint + reload shortly before
// `exp` so the iframe always holds a fresh token.
const REMINT_LEAD_MS = 60_000;
const MIN_REMINT_DELAY_MS = 10_000;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function clearRefresh(): void {
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}

function scheduleRefresh(expMs: number): void {
  clearRefresh();
  const delay = Math.max(expMs - Date.now() - REMINT_LEAD_MS, MIN_REMINT_DELAY_MS);
  refreshTimer = setTimeout(() => void load(), delay);
}

// Monotonic load id: a switch/refresh that starts a newer load() must win, so
// a slower in-flight load can't clobber the current view's srcdoc when it
// finally resolves. Each load captures its id and bails on every commit if a
// newer load has started.
let loadSeq = 0;

async function load(): Promise<void> {
  clearRefresh();
  const seq = ++loadSeq;
  const stale = (): boolean => seq !== loadSeq;
  loading.value = true;
  error.value = null;
  srcdoc.value = null;
  const binding = collectionUi();
  try {
    // 1. Mint a scoped token for this view's declared capabilities.
    const mint = await binding.mintViewToken(props.slug, props.view.id);
    if (stale()) return;
    if (!mint.ok) {
      error.value = mint.error;
      return;
    }
    // Re-mint + reload before this token expires (the iframe can't do it itself).
    scheduleRefresh(mint.data.exp);
    // 2. Fetch the view's HTML (global-bearer; attached by the host).
    const resp = await binding.fetchViewHtml(props.slug, props.view.id);
    if (stale()) return;
    if (!resp.ok) {
      error.value = `HTTP ${resp.status}`;
      return;
    }
    // 3. Pull the translation dict (already locale-picked server-side).
    // Always queried — when the view has no `i18n` declared the server returns
    // the empty contract `{ locale: "", dict: {} }`, so the iframe-side
    // `__MC_VIEW.t(key)` falls back to the key. A network failure is also
    // soft — the view renders without translations rather than 404'ing.
    const i18n = await binding.fetchViewI18n(props.slug, props.view.id, binding.localeTag());
    if (stale()) return;
    const i18nBoot = i18n.ok ? i18n.data : { locale: "", dict: {} };
    // 4. Render it sandboxed with the token + CSP + dict injected.
    srcdoc.value = binding.buildViewSrcdoc(resp.html, {
      slug: props.slug,
      token: mint.data.token,
      dataUrl: mint.data.dataUrl,
      origin: window.location.origin,
      locale: i18nBoot.locale,
      dict: i18nBoot.dict,
    });
  } catch (err) {
    if (!stale()) error.value = errorMessage(err);
  } finally {
    if (!stale()) loading.value = false;
  }
}

// Reload (re-mint + re-fetch) whenever the selected view or collection changes
// — and also whenever the active app locale flips, so a sandboxed view picks
// up freshly-translated strings without the user having to switch view +
// back. `localeTag()` is documented as reactive (the binding doc on
// `CollectionUi.localeTag`); reading it inside the watch source array lets
// Vue track that dep transparently.
watch([() => props.slug, () => props.view.id, () => collectionUi().localeTag()], () => void load(), { immediate: true });

// ── Live updates ──
// The sandboxed iframe can't open its own authenticated pub/sub socket, so the
// host parent subscribes (via the optional `subscribeChanges` capability) and
// relays a `{ type: "mc-collection-changed", slug }` message into the iframe on
// every record change. The injected `window.__MC_VIEW.onChange(cb)` helper
// validates + debounces it and re-fetches through the token the view already
// holds. The message carries no secret. If the host omits `subscribeChanges`,
// custom views simply keep their fetch-on-load behaviour.
let changeUnsub: (() => void) | null = null;

function relayChange(): void {
  // `"*"` target is safe: the payload is just a refetch ping (no token/data),
  // and the iframe-side handler verifies the message came from `window.parent`.
  iframeEl.value?.contentWindow?.postMessage({ type: "mc-collection-changed", slug: props.slug }, "*");
}

watch(
  () => props.slug,
  (slug) => {
    changeUnsub?.();
    changeUnsub = null;
    const subscribe = collectionUi().subscribeChanges;
    if (slug && subscribe) changeUnsub = subscribe(slug, relayChange);
  },
  { immediate: true },
);

// ── View → host action bridge ──
// The view calls `__MC_VIEW.openItem(id, mode)` / `.startChat(prompt, role)`,
// which post an `mc-open-item` / `mc-start-chat` message up to here. Verify it
// came from THIS view's iframe and is for THIS collection, then hand the action
// to the host. The messages carry no secret; the capability token is unaffected.
function handleOpenItem(body: { id?: unknown; mode?: unknown }): void {
  const itemId = typeof body.id === "string" ? body.id : String(body.id ?? "");
  if (!itemId) return;
  emit("openItem", { id: itemId, mode: body.mode === "edit" ? "edit" : "view" });
}

function handleStartChat(body: { prompt?: unknown; role?: unknown }): void {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return;
  emit("startChat", { prompt, role: typeof body.role === "string" ? body.role : undefined });
}

function onWindowMessage(event: MessageEvent): void {
  if (event.source !== iframeEl.value?.contentWindow) return;
  const msg: unknown = event.data;
  if (typeof msg !== "object" || msg === null) return;
  if (!("slug" in msg) || msg.slug !== props.slug) return;
  const type = "type" in msg ? msg.type : undefined;
  if (type === "mc-open-item") handleOpenItem({ id: "id" in msg ? msg.id : undefined, mode: "mode" in msg ? msg.mode : undefined });
  else if (type === "mc-start-chat") handleStartChat({ prompt: "prompt" in msg ? msg.prompt : undefined, role: "role" in msg ? msg.role : undefined });
}

onMounted(() => window.addEventListener("message", onWindowMessage));

onBeforeUnmount(() => {
  clearRefresh();
  changeUnsub?.();
  changeUnsub = null;
  window.removeEventListener("message", onWindowMessage);
});
</script>

<style scoped>
.custom-view-container {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: white;
  overflow: hidden;
}

.custom-view-message {
  padding: 1rem;
  font-size: 0.875rem;
  color: #64748b;
}

[role="alert"].custom-view-message {
  color: #b71c1c;
}
</style>
