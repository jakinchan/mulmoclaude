// Per-book event-stream contract for the accounting plugin — the
// reusable channel-name factory + event-kind enum + payload shape.
// Single source of truth for both publishers (the package's server
// surface, `eventPublisher`) and subscribers (the Vue View's
// `useAccountingChannel`), so anyone branching on event kind imports
// from here and the type system catches drift on either side.
//
// Lives in the package's `./shared` (browser-safe) rather than the
// host META because the backend needs it too — keeping it host-side
// would force an uphill import. The host-wiring META (toolName /
// apiNamespace / workspaceDirs / staticChannels) stays in the host's
// `src/plugins/accounting/meta.ts` so the plugin-barrel codegen
// discovers it.
//
// Browser-safe: no Vue imports, no server-only imports.

/** Channel factory for per-book event streams. Subscribers:
 *  `useAccountingChannel(bookId)`. Publisher: the package's server
 *  surface `eventPublisher`.
 *
 *  `scope` is the host's OPAQUE project id for the root the book lives
 *  under, for a multi-root host where a bookId is unique within a root
 *  and nowhere else — without it, a write to `main` in project A
 *  refreshes an open view of `main` in project B. Absent / `null` means
 *  the host's default root, and the name stays byte-identical to a
 *  single-root host's. It is an id, never a path: these names reach the
 *  browser. */
export function bookChannel(bookId: string, scope?: string | null): string {
  return scope ? `accounting:${scope}:${bookId}` : `accounting:${bookId}`;
}

/** Book-list-level channel — a book was created / deleted. Subscribers
 *  refetch the BookSwitcher dropdown. Mirrors the host META's
 *  `staticChannels.accountingBooks` literal (kept in sync by value;
 *  the host META stays the codegen-discoverable source for the
 *  aggregator merge). */
export const ACCOUNTING_BOOKS_CHANNEL = "accounting:books";

/** Scoped form of `ACCOUNTING_BOOKS_CHANNEL` — same rules as
 *  `bookChannel`'s `scope`. Unscoped it IS `ACCOUNTING_BOOKS_CHANNEL`.
 *
 *  The `#` is load-bearing: `books` is a legal book id (`isSafeBookId`),
 *  so a plain `accounting:<scope>:books` would be exactly
 *  `bookChannel("books", scope)` and the two streams would cross. `#` is
 *  not a legal id character, so the scoped names cannot collide. The
 *  UNSCOPED pair still can — `accounting:books` has meant the book list
 *  since before scopes existed and renaming it would break every
 *  subscriber — which is a pre-existing spurious-refresh quirk for a
 *  book literally named `books`, not something this scope introduces. */
export function booksChannel(scope?: string | null): string {
  return scope ? `accounting:${scope}:#books` : ACCOUNTING_BOOKS_CHANNEL;
}

/** Event kinds that ride `bookChannel(bookId)`. Single source of
 *  truth for both publishers (server/accounting) and subscribers
 *  (the View) — anyone branching on event kind imports from here
 *  and the type system catches drift on either side.
 *
 *  - `journal`             — addEntry / voidEntry hit the books at `period`.
 *                            Refetch the journal list and (if the View is
 *                            showing balances at or after `period`) the
 *                            relevant report.
 *  - `opening`             — setOpeningBalances. Affects every period from
 *                            the opening date forward; refetch everything.
 *  - `accounts`            — chart-of-accounts mutation that may affect
 *                            aggregation (account type changed). Refetch
 *                            accounts and the active report.
 *  - `snapshotsRebuilding` / `snapshotsReady` — purely informational;
 *                            the View can show a "calculating" spinner
 *                            during rebuild, but the lazy-rebuild safety
 *                            net means a refetch always returns the right
 *                            answer regardless. */
export const BOOK_EVENT_KINDS = {
  journal: "journal",
  opening: "opening",
  accounts: "accounts",
  snapshotsRebuilding: "snapshots-rebuilding",
  snapshotsReady: "snapshots-ready",
} as const;

export type BookEventKind = (typeof BOOK_EVENT_KINDS)[keyof typeof BOOK_EVENT_KINDS];

/** Payload published on `bookChannel(bookId)`. */
export interface BookChannelPayload {
  kind: BookEventKind;
  /** YYYY-MM. Present for `journal` (entry month) and the snapshot
   *  events (the earliest invalidated month). Absent for `opening`
   *  (which invalidates everything) and `accounts`. */
  period?: string;
}
