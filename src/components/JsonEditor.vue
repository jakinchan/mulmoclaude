<template>
  <div ref="host" data-testid="files-json-editor" class="cm-json-host border border-gray-300 rounded overflow-hidden"></div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { lintGutter, linter } from "@codemirror/lint";

const props = defineProps<{
  modelValue: string;
  editorLabel: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
// True only while we're pushing an external modelValue into the view,
// so the resulting update doesn't echo back as an emit (feedback loop).
let applyingExternal = false;
// Holds the aria-label content attribute so it can be hot-swapped via
// reconfigure when the locale (and thus editorLabel) changes while the
// editor is open — parity with the old reactive `:aria-label`.
const labelCompartment = new Compartment();

function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      bracketMatching(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      json(),
      // Inline parse-error squiggle as you type — complements the
      // server-side 400 (defence in depth, faster feedback).
      linter(jsonParseLinter()),
      lintGutter(),
      // Accessible name for the contenteditable (a11y; mirrors the
      // old <textarea aria-label>). In a Compartment so a locale
      // change can reconfigure it live.
      labelCompartment.of(EditorView.contentAttributes.of({ "aria-label": props.editorLabel })),
      EditorView.theme({
        "&": { fontSize: "12px" },
        ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
        "&.cm-focused": { outline: "2px solid rgb(96 165 250)" },
        ".cm-scroller": { overflow: "auto" },
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applyingExternal) return;
        emit("update:modelValue", update.state.doc.toString());
      }),
    ],
  });
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({ state: createState(props.modelValue), parent: host.value });
});

// External resets (e.g. jsonDraft re-seeded on Edit / file switch).
// Only reconcile when the value genuinely differs from the editor's
// current doc, so normal typing isn't clobbered mid-keystroke.
watch(
  () => props.modelValue,
  (next) => {
    if (!view || next === view.state.doc.toString()) return;
    applyingExternal = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    applyingExternal = false;
  },
);

// Locale can change while the editor is open — keep the accessible
// name in sync (parity with the old reactive `<textarea :aria-label>`).
watch(
  () => props.editorLabel,
  (label) => {
    view?.dispatch({ effects: labelCompartment.reconfigure(EditorView.contentAttributes.of({ "aria-label": label })) });
  },
);

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<style scoped>
.cm-json-host :deep(.cm-editor) {
  height: 100%;
}
</style>
