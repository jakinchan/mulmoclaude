// The host hands a tool result's `data` / `jsonData` through untyped, so the
// two chat surfaces read the render payload back out field by field instead of
// trusting whatever produced the result.

import type { PresentCollectionData } from "@mulmoclaude/core/collection";

export function toPresentCollectionData(value: unknown): PresentCollectionData | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("collectionSlug" in value) || typeof value.collectionSlug !== "string") return null;
  const itemId = "itemId" in value && typeof value.itemId === "string" ? value.itemId : undefined;
  return { collectionSlug: value.collectionSlug, itemId };
}
