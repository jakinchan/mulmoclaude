<template>
  <!-- Chooser for creating a collection: two generic ways to start (free-form
       chat / guided form) plus a gallery of ready-made starters. Each path seeds
       a new chat; the starter prompts/titles/descriptions are translated into the
       active locale at runtime. See plans/done/feat-collection-starters-modal.md. -->
  <CollectionRecordModal @close="emit('close')">
    <div class="flex items-center justify-between border-b border-slate-100 px-5 py-4">
      <h2 class="text-lg font-semibold text-slate-800">{{ t("collectionsView.newCollection.title") }}</h2>
      <button
        type="button"
        class="h-8 w-8 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
        :aria-label="t('collectionsView.newCollection.close')"
        data-testid="new-collection-close"
        @click="emit('close')"
      >
        <span class="material-icons text-lg">close</span>
      </button>
    </div>

    <div class="overflow-y-auto px-5 py-5">
      <!-- Two generic actions -->
      <div class="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          class="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-all hover:border-indigo-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          data-testid="new-collection-guided"
          @click="startGuided"
        >
          <span class="material-icons text-indigo-600">dynamic_form</span>
          <span class="min-w-0">
            <span class="block font-semibold text-slate-800">{{ t("collectionsView.newCollection.guidedLabel") }}</span>
            <span class="block text-xs text-slate-500 mt-0.5">{{ t("collectionsView.newCollection.guidedDescription") }}</span>
          </span>
        </button>
        <button
          type="button"
          class="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-all hover:border-indigo-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          data-testid="new-collection-freeform"
          @click="startFreeform"
        >
          <span class="material-icons text-indigo-600">chat</span>
          <span class="min-w-0">
            <span class="block font-semibold text-slate-800">{{ t("collectionsView.newCollection.freeformLabel") }}</span>
            <span class="block text-xs text-slate-500 mt-0.5">{{ t("collectionsView.newCollection.freeformDescription") }}</span>
          </span>
        </button>
      </div>

      <!-- Template gallery -->
      <h3 class="mt-6 mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
        {{ t("collectionsView.newCollection.templatesHeading") }}
      </h3>
      <div class="grid gap-3 sm:grid-cols-2">
        <button
          v-for="starter in starters"
          :key="starter.id"
          type="button"
          class="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-all hover:border-teal-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-teal-500/20"
          :data-testid="`new-collection-starter-${starter.id}`"
          @click="startFromTemplate(starter)"
        >
          <span class="material-symbols-outlined text-teal-600">{{ starter.icon }}</span>
          <span class="min-w-0">
            <span class="block font-semibold text-slate-800 truncate">{{ starter.title }}</span>
            <span class="block text-xs text-slate-500 mt-0.5">{{ starter.description }}</span>
          </span>
        </button>
      </div>
    </div>
  </CollectionRecordModal>
</template>

<script setup lang="ts">
import { useCollectionI18n } from "../lang";
import { useCollectionUi } from "../scopedUi";
import { useTranslatedStarters } from "../useStarterTranslations";
import CollectionRecordModal from "./CollectionRecordModal.vue";
import type { CollectionStarter } from "../starters";

const emit = defineEmits<{ close: [] }>();

const { t, locale } = useCollectionI18n();
const cui = useCollectionUi();
const starters = useTranslatedStarters(locale);

// Free-form: seed an editable draft with the conventions-reading preamble (no
// presentForm instruction), so the LLM is pointed at config/helps/collection-skills.md
// while the user describes what they want in their own words before sending.
function startFreeform(): void {
  cui.startNewChatDraft(t("collectionsView.newCollection.freeformPrompt"), cui.generalRoleId);
  emit("close");
}

// Guided form: the original "+ collection" behavior — auto-send the prompt that
// drives the agent's `presentForm` collection-authoring flow.
function startGuided(): void {
  cui.startChat(t("collectionsView.addCollectionPrompt"), cui.generalRoleId);
  emit("close");
}

// Template: seed the (locale-translated) prompt as an editable draft so the user
// can tweak it before sending.
function startFromTemplate(starter: CollectionStarter): void {
  cui.startNewChatDraft(starter.prompt, cui.generalRoleId);
  emit("close");
}
</script>
