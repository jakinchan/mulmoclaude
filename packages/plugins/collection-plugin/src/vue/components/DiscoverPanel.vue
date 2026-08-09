<template>
  <div data-testid="discover-panel">
    <div v-if="loading" class="flex flex-col items-center justify-center py-20 text-sm text-slate-500 gap-3">
      <div class="h-8 w-8 border-2 border-teal-600/20 border-t-teal-600 rounded-full animate-spin"></div>
      <span>{{ t("common.loading") }}</span>
    </div>

    <div v-else-if="loadError" class="rounded-xl border border-red-200 bg-red-50/50 p-4 text-sm text-red-800 shadow-sm flex items-center gap-3">
      <span class="material-icons text-red-600">error</span>
      <span>{{ t("collectionsView.discover.loadFailed") }}: {{ loadError }}</span>
    </div>

    <div v-else-if="entries.length === 0" class="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500 shadow-sm">
      <span class="material-icons text-4xl text-slate-300 mb-2">travel_explore</span>
      <p class="font-medium text-slate-700">{{ t("collectionsView.discover.empty") }}</p>
    </div>

    <div v-else class="grid gap-4 sm:grid-cols-2">
      <div
        v-for="entry in entries"
        :key="entryKey(entry)"
        class="relative rounded-xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col gap-3"
        :data-testid="`discover-card-${entry.slug}`"
      >
        <div class="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl bg-teal-500"></div>
        <div class="flex items-center gap-3">
          <div class="h-11 w-11 flex items-center justify-center rounded-xl bg-teal-50 text-teal-600 border border-teal-100/50 shadow-sm shrink-0">
            <span class="material-symbols-outlined text-2xl">{{ entry.icon || "dataset" }}</span>
          </div>
          <div class="flex-1 min-w-0">
            <span class="block font-semibold text-slate-800 text-[15px] truncate">{{ entry.title }}</span>
            <span class="block text-[11px] text-slate-400 mt-0.5 truncate">
              {{ t("collectionsView.discover.by", { author: entry.author }) }} ·
              <code class="bg-slate-100 px-1 rounded text-slate-500 font-mono">{{ entry.slug }}</code>
              ·
              <span
                class="inline-block text-[10px] uppercase tracking-wider font-semibold text-teal-700 bg-teal-50 border border-teal-100 rounded px-1.5"
                :data-testid="`discover-registry-${entry.slug}`"
                :title="t('collectionsView.discover.registryBadge', { registry: entry.registryName })"
                >{{ entry.registryName }}</span
              >
            </span>
          </div>
        </div>

        <p v-if="entry.description" class="text-xs text-slate-500 leading-relaxed line-clamp-2">{{ entry.description }}</p>

        <div class="flex items-center gap-2 text-[10px] text-slate-400 uppercase tracking-wider font-semibold flex-wrap">
          <span>{{ t("collectionsView.discover.fields", { count: entry.fieldCount }) }}</span>
          <span v-if="entry.views.length" class="text-teal-600">· {{ entry.views.join(" · ") }}</span>
          <span v-if="entry.hasSeed">· {{ t("collectionsView.discover.samples", { count: entry.seedCount }) }}</span>
        </div>

        <div class="flex items-center justify-between pt-1 border-t border-slate-100">
          <span class="text-[10px] text-slate-400 font-mono">v{{ entry.version }}</span>
          <div class="flex items-center gap-2">
            <span v-if="stateOf(entry).status === 'error'" class="text-[11px] text-red-600" :data-testid="`discover-error-${entry.slug}`">
              {{ stateOf(entry).error }}
            </span>
            <button
              v-if="stateOf(entry).status === 'done'"
              type="button"
              class="h-7 px-2.5 flex items-center gap-1 rounded text-teal-700 hover:bg-teal-50 font-semibold text-xs transition-colors"
              :data-testid="`discover-open-${entry.slug}`"
              @click="openImported(entry)"
            >
              <span class="material-icons text-sm">north_east</span>
              <span>{{ doneLabel(entry) }} · {{ t("collectionsView.discover.open") }}</span>
            </button>
            <button
              v-else
              type="button"
              class="h-7 px-3 flex items-center gap-1 rounded bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white font-bold text-xs transition-colors shadow-sm"
              :disabled="stateOf(entry).status === 'importing'"
              :data-testid="`discover-import-${entry.slug}`"
              @click="doImport(entry)"
            >
              <span v-if="stateOf(entry).status === 'importing'" class="h-3 w-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
              <span v-else class="material-icons text-sm">download</span>
              <span>{{ stateOf(entry).status === "importing" ? t("collectionsView.discover.importing") : t("collectionsView.discover.import") }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useCollectionI18n } from "../lang";
import type { RegistryEntry } from "../uiContext";
import { useCollectionUi } from "../scopedUi";

const { t } = useCollectionI18n();
const cui = useCollectionUi();
// Emitted after a successful import so the parent can refresh its installed list
// (the newly-installed collection should show up on the Installed tab right away).
const emit = defineEmits<{ imported: [] }>();

interface ImportState {
  status: "idle" | "importing" | "done" | "error";
  localSlug?: string;
  updated?: boolean;
  error?: string;
}

const entries = ref<RegistryEntry[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const importStates = ref<Record<string, ImportState>>({});

// With multi-registry support `entry.id` (author/slug) is no longer unique
// across the merged catalog — two registries can ship the same author/slug.
// Pair with registryName so Vue's :key and the import-state record both stay
// collision-free.
function entryKey(entry: RegistryEntry): string {
  return `${entry.registryName}/${entry.id}`;
}

function stateOf(entry: RegistryEntry): ImportState {
  return importStates.value[entryKey(entry)] ?? { status: "idle" };
}

function setState(entry: RegistryEntry, state: ImportState): void {
  importStates.value = { ...importStates.value, [entryKey(entry)]: state };
}

// "Imported as movies-2" when the install was renamed to avoid clobbering an
// existing same-named collection; otherwise "Imported" / "Updated".
function doneLabel(entry: RegistryEntry): string {
  const state = stateOf(entry);
  if (state.localSlug && state.localSlug !== entry.slug) return t("collectionsView.discover.importedAs", { slug: state.localSlug });
  return state.updated ? t("collectionsView.discover.updated") : t("collectionsView.discover.imported");
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  const result = await cui.listRegistry();
  loading.value = false;
  if (!result.ok) {
    loadError.value = result.error;
    return;
  }
  entries.value = result.data.collections;
}

async function doImport(entry: RegistryEntry): Promise<void> {
  setState(entry, { status: "importing" });
  const result = await cui.importRegistry(entry.author, entry.slug, entry.registryName);
  if (!result.ok) {
    setState(entry, { status: "error", error: result.error });
    return;
  }
  setState(entry, { status: "done", localSlug: result.data.localSlug, updated: result.data.updated });
  emit("imported");
}

function openImported(entry: RegistryEntry): void {
  const state = stateOf(entry);
  if (state.localSlug) cui.gotoDetail("collection", state.localSlug);
}

onMounted(load);
</script>
