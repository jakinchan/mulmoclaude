// Keyboard navigation extracted from App.vue.
// Arrow keys scroll the canvas (main pane) or navigate the sidebar
// result list depending on which pane is active.

import type { Ref, ComputedRef } from "vue";
import type { ToolResultComplete } from "gui-chat-protocol/vue";
import { findScrollableChild } from "../utils/dom/scrollable";

const SCROLL_AMOUNT = 60;

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function isVerticalArrow(key: string): key is "ArrowUp" | "ArrowDown" {
  return key === "ArrowUp" || key === "ArrowDown";
}

function nextIndex(results: ToolResultComplete[], currentIndex: number, direction: "ArrowUp" | "ArrowDown"): number {
  if (currentIndex === -1) return direction === "ArrowDown" ? 0 : results.length - 1;
  if (direction === "ArrowUp") return Math.max(0, currentIndex - 1);
  return Math.min(results.length - 1, currentIndex + 1);
}

function resolveNextUuid(results: ToolResultComplete[], currentUuid: string | null, direction: "ArrowUp" | "ArrowDown"): string | null {
  if (results.length === 0) return null;
  const currentIndex = results.findIndex((result) => result.uuid === currentUuid);
  return results[nextIndex(results, currentIndex, direction)]?.uuid ?? null;
}

export function useKeyNavigation(opts: {
  canvasRef: Ref<HTMLDivElement | null>;
  activePane: Ref<"sidebar" | "main">;
  sidebarResults: ComputedRef<ToolResultComplete[]>;
  selectedResultUuid: ComputedRef<string | null> & {
    value: string | null;
  };
}) {
  const { canvasRef, activePane, sidebarResults, selectedResultUuid } = opts;

  function handleCanvasKeydown(event: KeyboardEvent): void {
    if (!isVerticalArrow(event.key)) return;
    if (isEditableTarget(event.target)) return;
    if (!canvasRef.value) return;
    const scrollable = findScrollableChild(canvasRef.value);
    if (!scrollable) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? SCROLL_AMOUNT : -SCROLL_AMOUNT;
    scrollable.scrollBy({ top: delta, behavior: "smooth" });
  }

  function handleKeyNavigation(event: KeyboardEvent): void {
    if (activePane.value !== "sidebar") return;
    if (isEditableTarget(event.target)) return;
    if (!isVerticalArrow(event.key)) return;
    event.preventDefault();
    const nextUuid = resolveNextUuid(sidebarResults.value, selectedResultUuid.value, event.key);
    if (nextUuid) selectedResultUuid.value = nextUuid;
  }

  return { handleCanvasKeydown, handleKeyNavigation };
}
