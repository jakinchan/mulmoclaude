// REST endpoint for the accounting plugin. Single POST dispatch
// route with an `action` discriminator — matches the todos /
// scheduler convention so the LLM-facing MCP bridge (which invokes
// `apiPost` with the tool args verbatim) plugs in without
// translation.
//
// The mounted `<AccountingApp>` View hits this same endpoint
// directly for tab switches, filter changes, and form submits — no
// LLM round trip per click. The MCP bridge calls into the same
// service layer, so manual clicks and Claude tool calls produce
// identical state changes.

import { Router, Request, Response } from "express";
import { isRecord, isUnknownArray } from "@mulmoclaude/common";

import { describeEntry, optionalRecord, optionalReportPeriod, optionalString } from "./bodyFields.js";

import {
  AccountingError,
  addEntries,
  createBook,
  updateBook,
  deleteBook,
  getBalanceSheetReport,
  getLedgerReport,
  getOpeningBalances,
  getProfitLossReport,
  getTimeSeriesReport,
  listAccounts,
  listBooks,
  listEntries,
  rebuildSnapshots,
  setOpeningBalances,
  upsertAccount,
  voidEntry,
} from "./service.js";
import type { BookSummary } from "../shared/types.js";
import { ACCOUNTING_ACTIONS, ACCOUNTING_API } from "../shared";
import { channelScopeFor, log } from "./context.js";
import { asyncHandler, type ErrorBody } from "./http.js";

export interface AccountingActionBody {
  action: string;
  [key: string]: unknown;
}

/** `ErrorBody` plus the structured detail this router attaches to a failed
 *  dispatch (see the `err.details` send below) — a superset, not a rival
 *  declaration of the same shape. */
interface AccountingErrorResponse extends ErrorBody {
  details?: unknown;
}

// Tool-result envelope for the MCP-driven `openBook` action. The
// frontend tool-result renderer keys off `kind: "accounting-app"`
// to mount `<AccountingApp>` (vs the compact `Preview.vue` which
// renders summaries for every other action). `message` is picked
// up by the MCP bridge and surfaced as the tool's text response
// to the LLM (server/agent/mcp-server.ts).
interface OpenBookToolResult {
  kind: "accounting-app";
  bookId: string;
  initialTab?: string | undefined;
  /** Same shape getBooks returns — included so an LLM that calls
   *  openBook doesn't need a follow-up getBooks round-trip to learn
   *  what other books exist before its next action. */
  books: BookSummary[];
  /** The host's OPAQUE scope id for the root this book lives under, so
   *  the mounted card fetches ITS OWN project rather than whatever the
   *  host has selected when it renders. Absent for a single-root host
   *  (and for a multi-root host's default root), which keeps the
   *  envelope byte-identical to what it has always been.
   *
   *  Stamped by the SERVER from the resolved root — it is never read
   *  off the request body, so the model cannot pick a project. */
  scope?: string;
}

type ActionRest = Omit<AccountingActionBody, "action">;
/** `root` is the workspace root this request resolved to — `undefined`
 *  means "the host's configured one", the single-root path. Every
 *  handler MUST pass it on to the service layer: under a multi-root
 *  host a dropped root is not an error but a silent read or write
 *  against the wrong project. */
type ActionHandler = (rest: ActionRest, root: string | undefined) => Promise<unknown>;

// Each action is a tiny adapter that pulls the typed slice it needs
// out of the loosely-typed body. Parsing of the slice shape itself
// lives inside the service layer (parseEntry, parseOpening,
// parseAccountInput) so the adapters can stay one-liners.

async function handleOpenBook(rest: ActionRest, root: string | undefined): Promise<OpenBookToolResult> {
  // openBook requires an explicit `bookId` that resolves to an
  // existing book. On a fresh workspace the LLM is expected to
  // call `createBook` first and then `openBook` with the new id.
  if (typeof rest.bookId !== "string" || rest.bookId === "") {
    throw new AccountingError(400, "openBook: bookId is required. Call 'getBooks' to enumerate, or 'createBook' first on a fresh workspace.");
  }
  const list = await listBooks(root);
  if (!list.books.some((book) => book.id === rest.bookId)) {
    throw new AccountingError(404, `openBook: book ${JSON.stringify(rest.bookId)} not found`);
  }
  const initialTab = typeof rest.initialTab === "string" ? rest.initialTab : undefined;
  const scope = channelScopeFor(root);
  return { kind: "accounting-app", bookId: rest.bookId, initialTab, books: list.books, ...(scope ? { scope } : {}) };
}

async function handleGetReport(rest: ActionRest, root: string | undefined): Promise<unknown> {
  const kind = typeof rest.kind === "string" ? rest.kind : "";
  const periodInput = optionalReportPeriod(rest.period);
  const bookId = optionalString(rest.bookId);
  // A period that is present but malformed reads as absent, so it
  // lands on this same message rather than reaching the report
  // builders as `${undefined}-01`. Spell the accepted shapes out —
  // the LLM repairs its own payload from this text.
  const periodRequired = (label: string) =>
    new AccountingError(400, `${label}: period is required — { kind: "month", period: "YYYY-MM" } or { kind: "range", from: "YYYY-MM-DD", to: "YYYY-MM-DD" }`);
  // `ledger` treats an absent period as "full history", which would turn a
  // period the caller DID send but got wrong into a silently wider answer
  // than they asked for. Sent-but-unusable is an error for every kind (#2765).
  // `null` counts as NOT sent: it is how a JSON caller spells "I am not using
  // this optional field", and rejecting it would break ledger calls that work
  // today.
  const periodSent = rest.period !== undefined && rest.period !== null;
  if (periodSent && !periodInput) throw periodRequired(`getReport ${kind || "(no kind)"}`);
  if (kind === "balance") {
    if (!periodInput) throw periodRequired("getReport balance");
    return getBalanceSheetReport({ bookId, period: periodInput }, root);
  }
  if (kind === "pl") {
    if (!periodInput) throw periodRequired("getReport pl");
    return getProfitLossReport({ bookId, period: periodInput }, root);
  }
  if (kind === "ledger") {
    // period is optional for ledger — full-history view from the
    // UI calls getLedger(accountCode, undefined, bookId). The
    // account code, however, is mandatory; without it the request
    // is meaningless and the service would 404 on a blank code.
    if (typeof rest.accountCode !== "string" || rest.accountCode === "") {
      throw new AccountingError(400, "getReport ledger: accountCode is required");
    }
    return getLedgerReport({ bookId, accountCode: rest.accountCode, period: periodInput }, root);
  }
  throw new AccountingError(400, `getReport: unknown kind ${JSON.stringify(kind)}`);
}

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  [ACCOUNTING_ACTIONS.openBook]: handleOpenBook,
  [ACCOUNTING_ACTIONS.getBooks]: (_rest, root) => listBooks(root),
  [ACCOUNTING_ACTIONS.createBook]: async (rest, root) => {
    // Surface bookId at the top level so the dispatch envelope's
    // `data` carries it like every other write action — the View
    // uses it to preselect the new book on mount.
    const result = await createBook(
      {
        name: typeof rest.name === "string" ? rest.name : "",
        currency: typeof rest.currency === "string" ? rest.currency : undefined,
        country: typeof rest.country === "string" ? rest.country : undefined,
        // Passed through raw — the service coerces + validates it (number,
        // numeric string, or a legacy "Q1".."Q4" token), 400ing garbage.
        fiscalYearEnd: rest.fiscalYearEnd,
      },
      root,
    );
    return { bookId: result.book.id, ...result };
  },
  [ACCOUNTING_ACTIONS.updateBook]: async (rest, root) => {
    const result = await updateBook(
      {
        bookId: typeof rest.bookId === "string" ? rest.bookId : "",
        name: typeof rest.name === "string" ? rest.name : undefined,
        country: typeof rest.country === "string" ? rest.country : undefined,
        // Passed through raw — the service coerces + validates it.
        fiscalYearEnd: rest.fiscalYearEnd,
      },
      root,
    );
    return { bookId: result.book.id, ...result };
  },
  [ACCOUNTING_ACTIONS.deleteBook]: (rest, root) =>
    deleteBook({ bookId: typeof rest.bookId === "string" ? rest.bookId : "", confirm: rest.confirm === true }, root),
  [ACCOUNTING_ACTIONS.getAccounts]: (rest, root) => listAccounts({ bookId: optionalString(rest.bookId) }, root),
  // `account` / `entries` / `lines` travel to the service as `unknown`:
  // the parsers there own the narrowing, so a bad field keeps its own
  // message ("debit must be a non-negative finite number") instead of
  // collapsing into a generic shape error the LLM can't repair from.
  [ACCOUNTING_ACTIONS.upsertAccount]: (rest, root) => upsertAccount({ bookId: optionalString(rest.bookId), account: rest.account }, root),
  [ACCOUNTING_ACTIONS.addEntries]: (rest, root) => addEntries({ bookId: optionalString(rest.bookId), entries: rest.entries }, root),
  [ACCOUNTING_ACTIONS.voidEntry]: (rest, root) =>
    voidEntry(
      {
        bookId: optionalString(rest.bookId),
        entryId: typeof rest.entryId === "string" ? rest.entryId : "",
        reason: optionalString(rest.reason),
        voidDate: optionalString(rest.voidDate),
      },
      root,
    ),
  [ACCOUNTING_ACTIONS.getJournalEntries]: (rest, root) =>
    listEntries(
      {
        bookId: optionalString(rest.bookId),
        from: optionalString(rest.from),
        to: optionalString(rest.to),
        accountCode: optionalString(rest.accountCode),
      },
      root,
    ),
  [ACCOUNTING_ACTIONS.getOpeningBalances]: (rest, root) => getOpeningBalances({ bookId: optionalString(rest.bookId) }, root),
  [ACCOUNTING_ACTIONS.setOpeningBalances]: (rest, root) =>
    setOpeningBalances(
      {
        bookId: optionalString(rest.bookId),
        asOfDate: typeof rest.asOfDate === "string" ? rest.asOfDate : "",
        // Omitted `lines` means the zero-line opening marker that unlocks
        // the View's gate, so it stays an empty array rather than a 400.
        lines: rest.lines ?? [],
        memo: optionalString(rest.memo),
      },
      root,
    ),
  [ACCOUNTING_ACTIONS.getReport]: handleGetReport,
  [ACCOUNTING_ACTIONS.getTimeSeries]: (rest, root) =>
    getTimeSeriesReport(
      {
        bookId: optionalString(rest.bookId),
        metric: rest.metric,
        granularity: rest.granularity,
        from: rest.from,
        to: rest.to,
        accountCode: rest.accountCode,
      },
      root,
    ),
  [ACCOUNTING_ACTIONS.rebuildSnapshots]: (rest, root) => rebuildSnapshots({ bookId: optionalString(rest.bookId) }, root),
};

// Actions whose tool-result envelope should carry a `data` field so
// the sidebar renders a preview card. Everything else returns
// without `data` and the host gates the preview off (silent action).
// Reads (lists / reports) and View-driven maintenance ops stay
// silent — they're invoked from inside the canvas and the LLM will
// summarise reads in its text reply anyway.
const PREVIEW_ACTIONS = new Set<string>([
  ACCOUNTING_ACTIONS.openBook,
  ACCOUNTING_ACTIONS.createBook,
  ACCOUNTING_ACTIONS.updateBook,
  ACCOUNTING_ACTIONS.upsertAccount,
  ACCOUNTING_ACTIONS.addEntries,
  ACCOUNTING_ACTIONS.voidEntry,
  ACCOUNTING_ACTIONS.setOpeningBalances,
]);

// LLM-facing `message` tacked onto YES actions. The shared trailer
// ("The accounting view is shown to the user.") tells the LLM that a
// canvas / sidebar surface is already visible, so its text reply
// shouldn't redundantly enumerate the result the user can see — it
// should narrate what was *done*, not re-list what's on screen.
const VIEW_VISIBLE_TRAILER = "The accounting view is shown to the user.";

type MessageBuilder = (fields: Record<string, unknown>) => string;

const MESSAGE_BUILDERS: Record<string, MessageBuilder> = {
  [ACCOUNTING_ACTIONS.openBook]: (fields) => {
    // Include the books list inline so the LLM doesn't need a
    // follow-up getBooks round-trip before deciding what to do
    // next.
    const { books, bookId } = fields;
    const booksFragment = Array.isArray(books) ? ` Books available: ${JSON.stringify(books)}.` : "";
    const idFragment = typeof bookId === "string" ? ` (book id: ${bookId})` : "";
    return `Mounted the accounting app in the canvas${idFragment}.${booksFragment}`;
  },
  [ACCOUNTING_ACTIONS.createBook]: (fields) => {
    const book = optionalRecord(fields.book);
    const name = optionalString(book?.name);
    const bookId = optionalString(book?.id);
    const subject = name ? `A new book named ${JSON.stringify(name)}` : "A new book";
    // The LLM needs book.id to call any follow-up action on this
    // book (getAccounts, addEntries, etc.), so include it in the
    // status message instead of forcing a round-trip via getBooks.
    const idFragment = bookId ? ` (id: ${bookId})` : "";
    // The View's opening-gate hides every tab except `opening` and
    // `settings` until an opening entry is on file (even a zero-line
    // one). If the agent doesn't tell the user to set opening
    // balances first, the user's "can I add an entry?" attempt
    // silently fails because the New Entry tab isn't even visible.
    // Include the next-step instruction inline so the agent's reply
    // matches the UI's actual constraints.
    return `${subject} has been created${idFragment}. Next required step: set opening balances via setOpeningBalances — the journal-entry, ledger, and report tabs are locked until an opening (even an empty one) is saved.`;
  },
  [ACCOUNTING_ACTIONS.upsertAccount]: (fields) => {
    const account = optionalRecord(fields.account);
    const code = optionalString(account?.code);
    const name = optionalString(account?.name);
    if (code && name) {
      return `Upserted account ${code} ${JSON.stringify(name)}.`;
    }
    return "Updated the chart of accounts.";
  },
  [ACCOUNTING_ACTIONS.addEntries]: (fields) => {
    const entries = (isUnknownArray(fields.entries) ? fields.entries : []).map(describeEntry);
    const [firstEntry, ...furtherEntries] = entries;
    if (!firstEntry) return "Posted 0 journal entries.";
    if (furtherEntries.length === 0) {
      const idFragment = firstEntry.id ? ` (id: ${firstEntry.id})` : "";
      return `Posted a journal entry on ${firstEntry.date ?? "the requested date"}${idFragment}.`;
    }
    // Surface every id so the LLM can later voidEntry any one of
    // them without a follow-up getJournalEntries round-trip.
    const summary = entries.map((entry) => `${entry.date ?? "?"} (id: ${entry.id ?? "?"})`).join(", ");
    return `Posted ${entries.length} journal entries: ${summary}.`;
  },
  [ACCOUNTING_ACTIONS.voidEntry]: (fields) => {
    const reverseDate = optionalString(optionalRecord(fields.reverseEntry)?.date);
    return `Voided the entry; a reversing pair was posted on ${reverseDate ?? "today"}.`;
  },
  [ACCOUNTING_ACTIONS.setOpeningBalances]: (fields) => {
    const opening = optionalRecord(fields.openingEntry);
    const verb = fields.replacedExisting === true ? "replaced" : "set";
    const date = optionalString(opening?.date) ?? "the requested date";
    // Surface the actual lines so the LLM can answer follow-up
    // questions like "what's my opening cash?" without a separate
    // getOpeningBalances round-trip. An empty-marker opening
    // (zero lines, used to unlock the gate) gets no fragment.
    const openingLines = opening?.lines;
    const lines = isUnknownArray(openingLines) ? openingLines : [];
    const linesFragment = lines.length > 0 ? ` Lines: ${JSON.stringify(lines)}.` : "";
    return `Opening balances were ${verb} as of ${date}.${linesFragment}`;
  },
  [ACCOUNTING_ACTIONS.deleteBook]: (fields) => {
    const bookId = optionalString(fields.deletedBookId);
    const name = optionalString(fields.deletedBookName);
    const subject = name ? `the book ${JSON.stringify(name)}` : "the book";
    const idFragment = bookId ? ` (id: ${bookId})` : "";
    return `Deleted ${subject}${idFragment}.`;
  },
  [ACCOUNTING_ACTIONS.updateBook]: (fields) => {
    const book = optionalRecord(fields.book);
    const bookName = optionalString(book?.name);
    const country = optionalString(book?.country);
    const name = bookName ? JSON.stringify(bookName) : "the book";
    const countryFragment = country ? ` (country: ${country})` : "";
    return `Updated ${name}${countryFragment}.`;
  },
};

/** Read a record entry under a user/LLM-controlled key. The
 *  `Object.hasOwn` gate is load-bearing: a bare `record[key]` resolves
 *  inherited prototype members, so a crafted action ("constructor",
 *  "toString") would dispatch to an unexpected target instead of
 *  reading as absent. */
function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function previewMessage(action: string, fields: Record<string, unknown>): string {
  const head = ownEntry(MESSAGE_BUILDERS, action)?.(fields);
  return head ? `${head} ${VIEW_VISIBLE_TRAILER}` : VIEW_VISIBLE_TRAILER;
}

async function dispatch(body: AccountingActionBody, root: string | undefined): Promise<unknown> {
  const { action, ...rest } = body;
  const handler = ownEntry(ACTION_HANDLERS, action);
  if (!handler) throw new AccountingError(400, `unknown action ${JSON.stringify(action)}`);
  // Stamp the dispatch verb onto the response so the MCP bridge's
  // spread `{ toolName, uuid, ...result }` surfaces it as
  // `ToolResult.action`. The sidebar reads this to label cards as
  // `manageAccounting(openBook)` etc., and it round-trips a refresh
  // because the result envelope is persisted to the chat log.
  // Direct browser callers (the AccountingApp view) ignore the field.
  // Service responses that already set `action` win via the spread.
  const result = await handler(rest, root);
  // `isRecord` rejects arrays where the previous `typeof === "object"`
  // check accepted them — an array result would have spread into
  // `{0: …, 1: …}`. Every service function returns a plain object, so
  // nothing changes today; an array would now arrive as `{ value: [...] }`.
  const handlerFields = isRecord(result) ? result : { value: result };
  // `data` is the host's preview-eligibility signal (see
  // SessionSidebar.vue's v-if gate). Mirror the handler payload
  // into it for the actions that should render a card; leave it
  // off for silent ones so the gate suppresses the preview.
  const dataField = PREVIEW_ACTIONS.has(action) ? { data: { action, ...handlerFields } } : {};
  // The MCP bridge only forwards `message` / `instructions` to the
  // LLM (`data` / `jsonData` reach the view but not the model). So
  // every action MUST set a message — silence resolves to "Done"
  // and gives the LLM nothing to reason about. Resolution order:
  //   1. handler-set `message` wins (reserved for special-case
  //      narration that the standard MESSAGE_BUILDER can't capture);
  //   2. an action with a registered MESSAGE_BUILDER gets the
  //      per-action human-friendly summary; this is decoupled from
  //      PREVIEW_ACTIONS so silent ops like deleteBook can still
  //      narrate without earning a card;
  //   3. everything else returns the JSON-stringified handler
  //      payload so the LLM can read the raw data.
  const handlerMessage = typeof handlerFields.message === "string" ? handlerFields.message : undefined;
  const messageField = handlerMessage
    ? {}
    : MESSAGE_BUILDERS[action]
      ? { message: previewMessage(action, handlerFields) }
      : { message: JSON.stringify(handlerFields) };
  return { action, ...handlerFields, ...messageField, ...dataField };
}

/** The request shape the dispatch route hands a host resolver — the
 *  same one the route itself is typed with, so a host can read headers,
 *  query and the parsed body without casting. */
export type AccountingDispatchRequest = Request<object, unknown, AccountingActionBody>;

export interface AccountingRouterOptions {
  /** Resolve the workspace root ONE request operates on, for a host
   *  that serves more than one (MulmoTerminal: one root per project
   *  directory). Return `undefined` to use the host's configured root.
   *
   *  The resolver is entirely host-owned and the package never reads a
   *  root or a project id off the request body itself. That is what
   *  keeps the model out of it: `manageAccounting`'s tool schema has no
   *  project parameter, so an LLM cannot name a project even by
   *  guessing — the host derives the scope from the session, exactly as
   *  `manageCollection` does. A host that DOES accept a project id from
   *  a browser must resolve it against its own list of projects and
   *  never accept a path (see `AccountingServerDeps.channelScopeForRoot`). */
  resolveWorkspaceRoot?: (req: AccountingDispatchRequest) => string | undefined;
}

/** Build the accounting Express router. The host injects its workspace
 *  root + logger via `configureAccountingServer(...)` and pub/sub via
 *  `initAccountingEventPublisher(...)`, then mounts the returned router
 *  with `app.use(...)`. Pass `resolveWorkspaceRoot` to serve more than
 *  one root; omit it and every request uses the configured one. */
export function createAccountingRouter(options: AccountingRouterOptions = {}): Router {
  const router = Router();
  router.post(
    ACCOUNTING_API.dispatch.path,
    asyncHandler<Request<object, unknown, AccountingActionBody>, Response<unknown | AccountingErrorResponse>>(
      "accounting",
      "accounting dispatch failed",
      async (req, res) => {
        // Validate the body shape up front so a missing / non-object body
        // surfaces as a 400 instead of crashing `dispatch` and bubbling
        // through to the 500 catch-all.
        const { body } = req;
        if (!body || typeof body !== "object" || typeof body.action !== "string") {
          log.warn("accounting", "POST dispatch: invalid body");
          res.status(400).json({ error: "request body must be an object with a string `action` field" });
          return;
        }
        const { action } = body;
        log.info("accounting", "POST dispatch: start", { action });
        try {
          // Inside the try: a host resolver rejects an unknown project id
          // by throwing, and that is a 4xx about the request, not a
          // server fault — resolving it out here would skip the
          // AccountingError mapping below and answer a bad project with
          // a generic 500.
          const root = options.resolveWorkspaceRoot?.(req);
          const result = await dispatch(body, root);
          log.info("accounting", "POST dispatch: ok", { action });
          res.json(result);
        } catch (err) {
          // Domain errors (AccountingError) map to 4xx with `details`.
          // Anything else rethrows — the asyncHandler wrapper catches
          // it, logs `unexpected error`, and returns a generic 500.
          if (err instanceof AccountingError) {
            log.warn("accounting", "POST dispatch: error", { action, status: err.status, message: err.message });
            res.status(err.status).json({ error: err.message, details: err.details });
            return;
          }
          throw err;
        }
      },
    ),
  );
  return router;
}
