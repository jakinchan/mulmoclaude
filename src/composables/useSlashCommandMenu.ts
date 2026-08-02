// Inline slash-command autocomplete for the chat input. When the whole
// input is a bare `/token` (no space yet), the menu lists matching skills
// and the user can filter by typing, navigate with Arrow keys, and pick
// one to populate the textarea (selection populates, it does NOT send).
//
// Data comes from the same `useSkillsList()` module-level store the
// lightbulb Skills tab uses — this composable owns the open/filter/highlight
// state, and `handleSlashMenuKeydown` is the shared keyboard handler the
// composer wires ahead of `useImeAwareEnter`.

import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import type { SkillSummary } from "./useSkillsList";

// Whole input must be a single `/token` with no whitespace. The moment a
// space appears (`/foo `) it's a command-with-args and the menu closes.
const SLASH_QUERY_RE = /^\/(\S*)$/;

/** Returns the query after `/` when the input is a bare `/token`, else null. */
export function parseSlashQuery(value: string): string | null {
  return SLASH_QUERY_RE.exec(value)?.[1] ?? null;
}

/** Case-insensitive prefix match on skill name (empty query matches all). */
export function filterSkillsByPrefix(skills: readonly SkillSummary[], query: string): SkillSummary[] {
  const needle = query.toLowerCase();
  return skills.filter((skill) => skill.name.toLowerCase().startsWith(needle));
}

export interface SlashCommandMenu {
  isOpen: ComputedRef<boolean>;
  query: ComputedRef<string | null>;
  items: ComputedRef<SkillSummary[]>;
  highlightedIndex: Ref<number>;
  highlightedSkill: ComputedRef<SkillSummary | null>;
  moveHighlight: (delta: number) => void;
  setHighlight: (index: number) => void;
  dismiss: () => void;
}

interface HighlightControls {
  highlightedIndex: Ref<number>;
  highlightedSkill: ComputedRef<SkillSummary | null>;
  moveHighlight: (delta: number) => void;
  setHighlight: (index: number) => void;
}

/** Highlight cursor over `items` with wrap-around navigation. */
function useHighlight(items: ComputedRef<SkillSummary[]>): HighlightControls {
  const highlightedIndex = ref(0);
  const highlightedSkill = computed(() => items.value[highlightedIndex.value] ?? null);
  function moveHighlight(delta: number): void {
    const count = items.value.length;
    if (count === 0) return;
    highlightedIndex.value = (highlightedIndex.value + delta + count) % count;
  }
  const setHighlight = (index: number): void => {
    highlightedIndex.value = index;
  };
  return { highlightedIndex, highlightedSkill, moveHighlight, setHighlight };
}

/** Open/filter/highlight state for the inline "/" command palette. */
export function useSlashCommandMenu(value: Ref<string>, getSkills: () => readonly SkillSummary[]): SlashCommandMenu {
  const dismissed = ref(false);
  const query = computed(() => parseSlashQuery(value.value));
  const items = computed(() => {
    const prefix = query.value;
    return prefix === null ? [] : filterSkillsByPrefix(getSkills(), prefix);
  });
  const isOpen = computed(() => !dismissed.value && query.value !== null && items.value.length > 0);
  const highlight = useHighlight(items);

  // Any keystroke un-dismisses (Escape/blur only suppress until the user types
  // again) and resets the highlight so it never points past the freshly-
  // filtered list. `flush: "sync"` so the reset lands in the same tick as the
  // keystroke — a deferred reset would leave the highlight stale for one frame.
  watch(
    value,
    () => {
      dismissed.value = false;
      highlight.highlightedIndex.value = 0;
    },
    { flush: "sync" },
  );

  const dismiss = (): void => {
    dismissed.value = true;
  };
  return { isOpen, query, items, ...highlight, dismiss };
}

export interface SlashKeydownDeps {
  /** Predicate that flags an IME-confirming keydown (see useImeAwareEnter). */
  isImeConfirmation: (event: KeyboardEvent) => boolean;
  /** Populate the input with the chosen command. */
  onSelect: (skill: SkillSummary) => void;
}

function consume(event: KeyboardEvent, action: () => void): boolean {
  event.preventDefault();
  action();
  return true;
}

/** Enter/Tab selection, guarded so it never hijacks an IME confirmation. */
function selectHighlighted(menu: SlashCommandMenu, event: KeyboardEvent, deps: SlashKeydownDeps): boolean {
  if (event.shiftKey) return false; // Shift+Enter = newline, Shift+Tab = focus out
  // Safari fires compositionend BEFORE the confirming Enter (isComposing is
  // already false by then), so without this the menu would select on an IME
  // confirmation. Defer to the same race window useImeAwareEnter uses.
  if (deps.isImeConfirmation(event)) return false;
  const skill = menu.highlightedSkill.value;
  if (!skill) return false;
  return consume(event, () => deps.onSelect(skill));
}

/**
 * Handle a textarea keydown while the slash menu is open. Returns true when the
 * event was consumed — the caller must then NOT fall through to its send
 * handler. Wire this ahead of `useImeAwareEnter`'s onKeydown.
 */
export function handleSlashMenuKeydown(menu: SlashCommandMenu, event: KeyboardEvent, deps: SlashKeydownDeps): boolean {
  if (event.isComposing) return false; // let IME own the keys mid-composition
  switch (event.key) {
    case "ArrowDown":
      return consume(event, () => menu.moveHighlight(1));
    case "ArrowUp":
      return consume(event, () => menu.moveHighlight(-1));
    case "Escape":
      return consume(event, () => menu.dismiss());
    case "Enter":
    case "Tab":
      return selectHighlighted(menu, event, deps);
    default:
      return false;
  }
}
