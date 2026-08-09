// The host hands a tool result's `data` / `jsonData` through untyped, so the
// two chat surfaces read the render payload back out field by field instead of
// trusting whatever produced the result.

import type { PresentCollectionData } from "@mulmoclaude/core/collection";

export function toPresentCollectionData(value: unknown): PresentCollectionData | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("collectionSlug" in value) || typeof value.collectionSlug !== "string") return null;
  const itemId = "itemId" in value && typeof value.itemId === "string" ? value.itemId : undefined;
  // The root the card was MADE in (host-stamped, never from tool args — see
  // `PresentCollectionData.scope`). Read back out so the card can fetch under
  // its own project instead of whatever project is ambient when it renders.
  // Absent — the single-workspace case — leaves the key off entirely.
  const scope = "scope" in value && typeof value.scope === "string" && value.scope.trim().length > 0 ? value.scope.trim() : undefined;
  return { collectionSlug: value.collectionSlug, itemId, ...(scope ? { scope } : {}) };
}
