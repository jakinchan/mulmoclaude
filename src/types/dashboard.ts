// Shared shape for the dashboard layout — the grid of favorite
// collections shown on the /dashboard page.
//
// Membership (which collections appear) is derived from the user's
// pinned collection shortcuts (favorites); this file only stores the
// dashboard-specific overlay: per-tile view mode and tile order. Both
// are deliberately INDEPENDENT of the launcher's shortcut order and of
// a collection's own standalone view-mode preference, so reordering a
// tile or switching its view here never disturbs the launcher pill row
// or the full /collections/:slug page.
//
// Browser-safe (no Node imports) so both the Vue frontend and the
// Express server can import this single definition.

export interface DashboardTile {
  /** The collection's slug. Must match a pinned collection shortcut to
   *  render (stale entries are pruned on reconcile). */
  slug: string;
  /** The view mode this tile opens in — a `CollectionViewMode` key
   *  (`"table"` | `"calendar"` | `"kanban"` | `"custom:<id>"`). Kept as
   *  a plain string here so this browser/server-shared type carries no
   *  dependency on the collection-plugin's Vue layer; validated against
   *  the live schema at render time. Absent ⇒ the tile's default view. */
  viewMode?: string;
}

/** On-disk shape of `config/dashboard.json`. Object wrapper (not a bare
 *  array) so the schema can grow without a migration. */
export interface DashboardFile {
  tiles: DashboardTile[];
  /** View-area height (px) per grid row, keyed by the grid's column count
   *  (`"1"` | `"2"`) and then indexed by row within that layout. The
   *  height belongs to the SLOT, not the tiles in it: side-by-side tiles
   *  share their row's height, and it stays with the row position when
   *  tiles are reordered. Keying by column count keeps the narrow
   *  (1-column) and wide (2-column) layouts independent, so resizing on
   *  one doesn't shift heights on the other. `0` (or a missing index)
   *  means that row uses the default height. */
  rowHeights?: Record<string, number[]> | undefined;
}
