<template>
  <!-- Floats above the input (drop-up) without reflowing it. Parent `.p-2`
       is `relative`; this is `absolute bottom-full`. Items use
       `@mousedown.prevent` so a click selects without first blurring the
       textarea (which would otherwise fire @blur and dismiss the menu). -->
  <div
    ref="listRef"
    data-testid="slash-command-menu"
    role="listbox"
    class="absolute bottom-full left-0 right-0 mx-2 mb-1 max-h-64 overflow-y-auto rounded border border-gray-300 bg-white shadow-lg z-10"
  >
    <button
      v-for="(skill, index) in items"
      :key="skill.name"
      :data-testid="`slash-command-item-${skill.name}`"
      role="option"
      :aria-selected="index === highlightedIndex"
      class="w-full text-left px-3 py-1.5 flex flex-col gap-0.5 transition-colors"
      :class="index === highlightedIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-100'"
      @mousedown.prevent="emit('select', skill)"
      @mouseenter="emit('hover', index)"
    >
      <span class="text-xs font-medium">/{{ skill.name }}</span>
      <span v-if="skill.description" class="text-[11px] text-gray-500 truncate">{{ skill.description }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { SkillSummary } from "../composables/useSkillsList";

const props = defineProps<{
  items: readonly SkillSummary[];
  highlightedIndex: number;
}>();

const emit = defineEmits<{
  select: [skill: SkillSummary];
  hover: [index: number];
}>();

const listRef = ref<HTMLDivElement | null>(null);

// Keep the keyboard-highlighted row in view when navigation moves it past
// the visible window of the scroll container.
watch(
  () => props.highlightedIndex,
  (index) => {
    nextTick(() => {
      // `.item()` (not `children[i]`) so an out-of-range index is typed
      // and returns null instead of an implicitly-present Element.
      const option = listRef.value?.children.item(index);
      option?.scrollIntoView({ block: "nearest" });
    });
  },
);
</script>
