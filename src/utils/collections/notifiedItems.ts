// Map active bell notifications back to the collection records they
// point at, so views (the Kanban board) can flag a card that has a
// pending notification.
//
// Collection-completion entries are published by
// `server/workspace/collections/notifications.ts` with a typed
// `pluginData.action.target = { view: "collections", slug, itemId }`
// (see `LegacyNotifierPluginData`). `pluginData` arrives on the client
// as `unknown`, so we narrow defensively rather than trusting its shape.

import { NOTIFICATION_VIEWS } from "../../types/notification";

/** Bell severities, worst-last. Mirrors `NotifierEntry["severity"]`. The
 *  Kanban accent colours by this so it matches the bell badge / icon
 *  (urgent → red, nudge → amber). */
export type NotifierSeverity = "info" | "nudge" | "urgent";

const SEVERITY_RANK: Record<NotifierSeverity, number> = { info: 0, nudge: 1, urgent: 2 };

function asSeverity(value: unknown): NotifierSeverity {
  return value === "urgent" || value === "nudge" ? value : "info";
}

/** The minimum entry shape this module reads — a structural subset of
 *  `NotifierEntry` so callers can pass entries straight from
 *  `useNotifications()` without a cast. */
export interface NotifiedEntryLike {
  pluginData?: unknown | undefined;
  severity?: string | undefined;
}

interface CollectionTarget {
  slug: string;
  itemId?: string | undefined;
}

/** Narrow an entry's opaque `pluginData` to its collection navigate
 *  target, or null when it isn't a collection-targeting entry. */
function collectionTargetOf(pluginData: unknown): CollectionTarget | null {
  if (!pluginData || typeof pluginData !== "object") return null;
  const { action } = pluginData as { action?: unknown };
  if (!action || typeof action !== "object") return null;
  const { target } = action as { target?: unknown };
  if (!target || typeof target !== "object") return null;
  const { view, slug, itemId } = target as { view?: unknown; slug?: unknown; itemId?: unknown };
  if (view !== NOTIFICATION_VIEWS.collections || typeof slug !== "string") return null;
  return { slug, itemId: typeof itemId === "string" ? itemId : undefined };
}

/** Map of itemId → worst active-notification severity for records in `slug`.
 *  Only entries carrying a concrete `itemId` are included (a bare
 *  collection-level target can't highlight a specific card); when an item has
 *  several notifications the highest severity wins, so the accent matches the
 *  most urgent one. */
export function collectionNotifiedSeverities(entries: readonly NotifiedEntryLike[], slug: string): Map<string, NotifierSeverity> {
  const out = new Map<string, NotifierSeverity>();
  for (const entry of entries) {
    const target = collectionTargetOf(entry.pluginData);
    if (!target || target.slug !== slug || !target.itemId) continue;
    const severity = asSeverity(entry.severity);
    const existing = out.get(target.itemId);
    if (!existing || SEVERITY_RANK[severity] > SEVERITY_RANK[existing]) out.set(target.itemId, severity);
  }
  return out;
}
