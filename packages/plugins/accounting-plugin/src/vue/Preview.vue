<template>
  <!-- Compact inline summary for non-openBook tool results. The
       openBook envelope routes to View.vue (full app) instead of
       this component; everything that lands here is a
       compact-result action (addEntries, getReport, …). -->
  <div class="text-sm text-gray-700" data-testid="accounting-preview">
    <span class="material-icons text-base align-middle mr-1">account_balance</span>
    <span>{{ summary }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAccountingI18n } from "./lang";
import { summarisePreview } from "./previewSummary";

const { t } = useAccountingI18n();

// Some renderers carry the payload on `data`, others on `jsonData`;
// `summarisePreview` merges whichever arrived and picks the branch.
const props = defineProps<{ data?: unknown; jsonData?: Record<string, unknown> }>();

const summary = computed<string>(() => summarisePreview(props.data, props.jsonData, t));
</script>
