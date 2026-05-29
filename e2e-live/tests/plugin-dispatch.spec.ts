import { randomUUID } from "node:crypto";

import { type Page, expect, test } from "@playwright/test";

import { ONE_MINUTE_MS } from "../../server/utils/time.ts";
import { deleteSession, readSessionToolCalls, readWorkspaceFile, sendChatMessage, setupRoleSession, waitForAssistantTurn } from "../fixtures/live-chat.ts";
import { isRecord } from "../../server/utils/types.ts";

// Per-test wall-time budget. Some specs do two LLM turns (add +
// chat-driven delete), so the ceiling is a little roomier than the
// L-21 / L-21B 3-minute budget that only runs a single turn.
const DISPATCH_TIMEOUT_MS = 5 * ONE_MINUTE_MS;

// MCP prefix the host bridge prepends to every plugin-owned tool
// when the agent enumerates its tool catalog (see
// `server/agent/prompt.ts` MCP_PREFIX_HINT). Asserting on the
// prefixed form is what makes these canaries catch regressions where
// the bridge drops a plugin from the catalog, or re-prefixes it
// under a different server name — both shapes have shipped before
// and only the prefixed-name assertion catches them.
const MCP_PREFIX = "mcp__mulmoclaude__";

// One-turn dispatch canary covering plugins that have never had an
// e2e-live test before (see `plans/feat-e2e-live.md` §「未踏 plugin
// の 1 ターン dispatch test 棚卸し」). The shape is uniform across
// the 7 specs in this file: nonce-stamp a per-test marker, pick the
// simplest role that exposes the tool, send a prompt that names the
// tool by literal AND embeds the marker so it lands in the saved
// data, wait for the agent turn, read the per-session jsonl trace,
// assert >=1 tool_call record matches the expected MCP-prefixed
// tool name (and, for multi-action tools, the expected action), then
// ask the SAME chat session to delete what was just created (where
// the plugin exposes a delete action), then verify the marker is
// actually absent from the workspace DB (filesystem read; the LLM
// dispatched the delete branch AND the delete actually targeted the
// marker). Skip on `E2E_LIVE_NO_LLM=1` (fake-echo cannot route
// MCP dispatch).
//
// Why jsonl-only and not a View-mount assertion: 3 of the 7 plugins
// here have no top-level chat-inline View testid (todo / markdown /
// spreadsheet), 1 mounts a generic SchedulerView shared with the
// standalone route (calendar), and 1 is narrate-only from chat
// (accounting createBook does not mount the openBook envelope).
// A uniform jsonl assertion gives one shape across all 7 — adding
// View testids per plugin is a separate refactor (out of scope
// for this canary PR).
//
// Why cleanup is a second chat turn (todo / calendar / accounting):
// these plugins expose a delete action through the same MCP tool,
// so asking the LLM to delete what it just created exercises the
// full add+delete round-trip via the LLM API — same surface area
// the test is meant to canary. The post-cleanup `markerScopedFile`
// verification reads the workspace DB and asserts no row carries
// the marker, which catches both (a) "LLM dispatched delete but
// against the wrong id" and (b) "delete returned ok but didn't
// actually mutate the file". The 4 artifact-plugin specs (md /
// xls / svg / html) skip the cleanup turn because their `present*`
// tools have no delete counterpart — every saved file is meant to
// persist as a workspace artifact. The marker in the saved content
// keeps test-authored artifacts identifiable in `/files` so the
// developer can manually purge them later.
//
// Why per-test nonce: parallel runs and pre-existing user state
// must not collide with cleanup or the marker-absence assertion.
// A nonce-stamped marker also guarantees that any leftover artifact
// is unambiguously attributable to this test
// (`L-DISPATCH-MD-canary-<nonce>` in the markdown body / SVG title /
// spreadsheet sheet name).
//
// Specs run in parallel — each owns a fresh session pair and a
// unique nonce-stamped marker, so there is no cross-spec state.
test.describe.configure({ mode: "parallel" });

/**
 * Locates the per-test row inside a workspace JSON DB: which file,
 * which top-level array (`arrayPath` for nested shapes like
 * accounting's `{books: [...]}`; omit for top-level arrays like
 * todos.json), which item field carries the marker. Used by
 * `expectMarkerAbsent` after the cleanup turn to verify the delete
 * actually removed the marker row.
 */
interface MarkerScope {
  /** Workspace-relative file (`data/plugins/.../todos.json`, etc.). */
  workspaceRel: string;
  /** Nested path to the array of rows; omit when the file root IS the array. */
  arrayPath?: string;
  /** Object field that should equal the marker (`text`, `title`, `name`). */
  matchField: string;
}

interface PluginDispatchCase {
  /** Test id, used in the test title and the cleanup-side debug tag. */
  testId: string;
  /** Built-in role id whose `availablePlugins` lists this plugin. */
  role: string;
  /** Plain MCP tool name as declared in the plugin's `definition.ts`. */
  toolName: string;
  /**
   * Marker string the test asks the LLM to embed in the saved
   * artifact (todo text / event title / document body / cell value /
   * SVG <title> / HTML body / book name). Threaded into every
   * assertion error message so debug output points at the exact
   * marker that should have landed (Sourcery iter-1).
   */
  marker: string;
  /** Prompt body, designed to land the tool in one turn with no narration. */
  prompt: string;
  /**
   * For multi-action tools (todo / calendar / accounting), the
   * `args.action` literal the first turn MUST dispatch (`add`,
   * `add`, `createBook`). Without this gate the test would false-pass
   * when the LLM e.g. dispatches `show` / `getBooks` instead of the
   * write action the canary is meant to cover (Codex GHA iter-1).
   * Single-action tools (`presentDocument` etc.) leave it undefined.
   */
  expectedAddAction?: string;
  /**
   * Optional follow-up prompt that asks the SAME session to delete
   * the marker-stamped item. Present for plugins whose tool exposes
   * a delete action (todo / calendar / accounting); omitted for the
   * 4 `present*` artifact plugins where no delete tool exists.
   * MUST be set together with `expectedCleanupAction` and
   * `markerScopedFile` — runtime validation enforces all-or-none
   * (CodeRabbit iter-1).
   */
  cleanupPrompt?: string;
  /**
   * Required companion to `cleanupPrompt`: the literal value of the
   * MCP tool's `action` argument the cleanup turn MUST invoke
   * (`delete` for todo / calendar, `deleteBook` for accounting).
   * Used by the post-cleanup jsonl assertion to prove the agent
   * actually dispatched the delete branch — without it the cleanup
   * turn could narrate / ToolSearch / silently no-op and still let
   * the spec pass green (Codex iter-2).
   */
  expectedCleanupAction?: string;
  /**
   * Required companion to `cleanupPrompt`: locator for the DB row
   * that carried the marker before cleanup. After the cleanup turn
   * we re-read the file and assert no row matches — catches both
   * "delete dispatched but targeted the wrong id" and "delete
   * returned ok but the file didn't actually change" (Codex GHA
   * iter-1).
   */
  markerScopedFile?: MarkerScope;
}

/** Per-test unique marker suffix (epoch ms + 6 hex chars). */
function makeMarker(testId: string): string {
  return `${testId}-canary-${Date.now()}-${randomUUID().slice(0, 6)}`;
}

/**
 * Asserts the per-session jsonl trace contains >=1 `tool_call` to
 * the MCP-prefixed `toolName`. When `expectedAction` is provided
 * (multi-action tools), the `args.action` literal must match — a
 * `show` / `getBooks` call cannot satisfy a test whose claim is
 * "the add path was exercised". Read after `waitForAssistantTurn`
 * resolves; the jsonl flushes per-event and is empty until the
 * first record lands, so the gate is required to avoid a fast-path
 * race against an indicator that detached before the agent fired.
 */
async function expectToolDispatched(
  sessionId: string,
  toolName: string,
  marker: string,
  expectedAction: string | undefined,
  markerScopedFile: MarkerScope | undefined,
): Promise<void> {
  const expectedName = `${MCP_PREFIX}${toolName}`;
  const calls = await readSessionToolCalls(sessionId);
  const sameToolCalls = calls.filter((call) => call.toolName === expectedName);
  const matched = sameToolCalls.filter((call) => {
    if (expectedAction !== undefined) {
      if (!isRecord(call.args) || call.args.action !== expectedAction) return false;
    }
    return argsCarryMarker(call.args, marker, markerScopedFile);
  });
  const actionsSeen =
    sameToolCalls.map((call) => (isRecord(call.args) ? String(call.args.action ?? "<no-action>") : "<non-object-args>")).join(", ") || "<none>";
  const actionHint = expectedAction !== undefined ? ` tool_call with args.action='${expectedAction}'` : " tool_call";
  const matchKindHint = markerScopedFile !== undefined ? ` (strict args.${markerScopedFile.matchField}=='${marker}')` : " (marker substring anywhere in args)";
  expect(
    matched.length,
    `marker='${marker}': expected at least one ${expectedName}${actionHint} whose args carry the marker${matchKindHint} (saw tool actions: ${actionsSeen}; marker-carrying matches: ${matched.length})`,
  ).toBeGreaterThan(0);
}

/**
 * Two-mode marker check on tool_call args, dispatched on whether
 * this case has a marker-bearing DB field (todo / calendar /
 * accounting → `markerScopedFile` is set, and cleanup later asserts
 * `row[matchField] === marker` strictly) or not (artifact plugins
 * — marker is substring-embedded in a larger body string like the
 * markdown / HTML / SVG body, with no cleanup-side check at all):
 *
 * - **strict mode** (markerScopedFile set): args MUST have a
 *   top-level string field named `matchField` equal to the marker.
 *   Symmetric with `expectMarkerAbsent`'s `row[matchField] === marker`
 *   check, so a `prefix-${marker}` LLM hallucination can't pass the
 *   create-side gate while failing the cleanup-side lookup
 *   (Codex GHA iter-4 false-green path).
 *
 * - **substring mode** (markerScopedFile undefined): recursive walk
 *   that returns true iff any string leaf includes the marker.
 *   Needed for artifact plugins where the marker is embedded inside
 *   a longer body string (the markdown source `# ${marker}`, the
 *   HTML `<h1>${marker}</h1>`, the SVG `<title>${marker}</title>`,
 *   the spreadsheet `sheets[0].name`). These plugins have no
 *   delete tool so there is no cleanup-side strict check to be
 *   symmetric with.
 */
function argsCarryMarker(args: unknown, marker: string, markerScopedFile: MarkerScope | undefined): boolean {
  if (markerScopedFile !== undefined) {
    if (!isRecord(args)) return false;
    return args[markerScopedFile.matchField] === marker;
  }
  return argsSubstringMatch(args, marker);
}

function argsSubstringMatch(args: unknown, marker: string): boolean {
  if (typeof args === "string") return args.includes(marker);
  if (Array.isArray(args)) return args.some((item) => argsSubstringMatch(item, marker));
  if (isRecord(args)) return Object.values(args).some((value) => argsSubstringMatch(value, marker));
  return false;
}

/**
 * Count tool_calls already recorded against this session that
 * target the MCP-prefixed `toolName` with `args.action` equal to
 * `expectedAction`. Used as a baseline before the cleanup turn so
 * the post-cleanup assertion is turn-scoped: instead of "is there
 * any delete call in session history" (which an earlier add turn
 * could accidentally satisfy if it dispatched a delete pre-cleanup),
 * we assert "the cleanup turn dispatched ≥1 NEW delete call".
 * Codex iter-3 flagged this distinction.
 */
async function countToolActionCalls(sessionId: string, toolName: string, expectedAction: string): Promise<number> {
  const expectedName = `${MCP_PREFIX}${toolName}`;
  const calls = await readSessionToolCalls(sessionId);
  return calls.filter((call) => call.toolName === expectedName && isRecord(call.args) && call.args.action === expectedAction).length;
}

/**
 * Post-cleanup-turn assertion (jsonl side): prove the cleanup turn
 * ITSELF (not just session history) dispatched ≥1 tool_call to the
 * same MCP tool with `args.action` equal to the expected delete
 * literal. Compares against a baseline taken BEFORE the cleanup
 * prompt was sent, so an earlier delete dispatched in the same
 * session cannot satisfy the assertion (Codex iter-3).
 */
async function expectDeleteActionDispatched(sessionId: string, toolName: string, expectedAction: string, baselineCount: number, marker: string): Promise<void> {
  const expectedName = `${MCP_PREFIX}${toolName}`;
  const calls = await readSessionToolCalls(sessionId);
  const sameToolCalls = calls.filter((call) => call.toolName === expectedName);
  const totalDeleteCalls = sameToolCalls.filter((call) => isRecord(call.args) && call.args.action === expectedAction).length;
  const newDeleteCalls = totalDeleteCalls - baselineCount;
  expect(
    newDeleteCalls,
    `marker='${marker}': expected the cleanup turn to dispatch at least one ${expectedName} tool_call with args.action='${expectedAction}' (saw actions in session: ${
      sameToolCalls.map((call) => (isRecord(call.args) ? String(call.args.action ?? "<no-action>") : "<non-object-args>")).join(", ") || "<no-matching-tool>"
    }, baseline pre-cleanup=${baselineCount})`,
  ).toBeGreaterThan(0);
}

/**
 * Post-cleanup-turn assertion (filesystem side): re-read the
 * workspace DB and assert no row carries the marker. Catches the
 * gap the jsonl-side assertion alone leaves open: the LLM dispatched
 * `args.action='delete'` but against the wrong id (so the marker
 * row is still on disk), or the server returned ok but the write
 * silently failed.
 *
 * Fail-closed contract (Codex GHA iter-3): parse and shape failures
 * on these known DB files (todos.json, scheduler/items.json,
 * accounting/config.json) are real regressions, NOT pass-by-default.
 * Only ENOENT survives as a pass — the file being completely gone is
 * the strongest form of "marker absent", and for `[]`-shaped DBs
 * (todos / calendar) the server is allowed to unlink the file when
 * the last item is deleted (rather than write an empty array).
 */
async function expectMarkerAbsent(marker: string, scope: MarkerScope): Promise<void> {
  const raw = await readWorkspaceFile(scope.workspaceRel);
  if (raw === null) return;
  const parsed = safeJsonParse(raw);
  const arraySuffix = scope.arrayPath !== undefined ? `.${scope.arrayPath}` : "";
  const dbLocation = `${scope.workspaceRel}${arraySuffix}`;
  expect(
    parsed,
    `marker='${marker}': failed to JSON-parse ${scope.workspaceRel} after cleanup — DB is corrupted or a non-JSON file landed at this path`,
  ).not.toBeNull();
  const rows = extractRows(parsed, scope.arrayPath);
  expect(
    rows,
    `marker='${marker}': expected ${dbLocation} to be an array of rows after cleanup, but the shape did not match (DB schema may have drifted)`,
  ).not.toBeNull();
  const matches = (rows ?? []).filter((row) => isRecord(row) && row[scope.matchField] === marker);
  expect(
    matches.length,
    `marker='${marker}': expected zero rows in ${dbLocation} after cleanup, but found ${matches.length} matching '${scope.matchField}' (cleanup turn dispatched delete but the row was not actually removed — likely targeted the wrong id, or the delete write silently failed)`,
  ).toBe(0);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractRows(parsed: unknown, arrayPath: string | undefined): unknown[] | null {
  if (arrayPath === undefined) {
    return Array.isArray(parsed) ? parsed : null;
  }
  if (!isRecord(parsed)) return null;
  const nested = parsed[arrayPath];
  return Array.isArray(nested) ? nested : null;
}

/**
 * Fail fast if cleanup fields are configured partially. Without
 * this guard, setting only `cleanupPrompt` (forgetting
 * `expectedCleanupAction` or `markerScopedFile`) would silently
 * skip cleanup verification and let a misconfigured case pass
 * green (CodeRabbit iter-1).
 */
function assertCleanupConfigCoherent(kase: PluginDispatchCase): void {
  const present = [kase.cleanupPrompt !== undefined, kase.expectedCleanupAction !== undefined, kase.markerScopedFile !== undefined];
  const presentCount = present.filter(Boolean).length;
  if (presentCount === 0 || presentCount === present.length) return;
  throw new Error(
    `PluginDispatchCase(${kase.testId}): cleanupPrompt / expectedCleanupAction / markerScopedFile must be set together (got: cleanupPrompt=${kase.cleanupPrompt !== undefined}, expectedCleanupAction=${kase.expectedCleanupAction !== undefined}, markerScopedFile=${kase.markerScopedFile !== undefined})`,
  );
}

/**
 * Drive one plugin's canary: switch into the role that exposes the
 * tool, send the prompt, drain the turn, assert dispatch landed
 * (action-aware for multi-action tools). If a cleanup trio
 * (`cleanupPrompt` + `expectedCleanupAction` + `markerScopedFile`)
 * is configured, snapshot the existing delete-action call count,
 * send the cleanup prompt as a second turn, drain it, then assert
 * (a) the cleanup turn dispatched ≥1 NEW delete-action call and
 * (b) the marker row is actually gone from the workspace DB. The
 * session pair is always deleted in `finally`, regardless of
 * whether either turn passed.
 */
async function runDispatchCase(page: Page, kase: PluginDispatchCase): Promise<void> {
  test.setTimeout(DISPATCH_TIMEOUT_MS);
  assertCleanupConfigCoherent(kase);
  const sessionsToCleanup: string[] = [];
  try {
    const sessionId = await setupRoleSession(page, kase.role, sessionsToCleanup);
    await sendChatMessage(page, kase.prompt);
    await waitForAssistantTurn(page);
    await expectToolDispatched(sessionId, kase.toolName, kase.marker, kase.expectedAddAction, kase.markerScopedFile);
    if (kase.cleanupPrompt !== undefined && kase.expectedCleanupAction !== undefined && kase.markerScopedFile !== undefined) {
      const baselineDeleteCount = await countToolActionCalls(sessionId, kase.toolName, kase.expectedCleanupAction);
      await sendChatMessage(page, kase.cleanupPrompt);
      await waitForAssistantTurn(page);
      await expectDeleteActionDispatched(sessionId, kase.toolName, kase.expectedCleanupAction, baselineDeleteCount, kase.marker);
      await expectMarkerAbsent(kase.marker, kase.markerScopedFile);
    }
  } finally {
    for (const sid of sessionsToCleanup) {
      await deleteSession(page, sid);
    }
  }
}

// Workspace DB paths the cleanup verification reads back. Kept here
// as string literals because the runtime-plugin path is
// URL-encoded (`%40mulmoclaude%2Ftodo-plugin` for
// `@mulmoclaude/todo-plugin`) and there is no host-side constant
// that exposes the encoded form — a centralization PR (CodeRabbit
// "as-const refactor" suggestion) would land both these and the
// MCP tool-name literals in one go, but stays out of scope here.
const TODO_DB_REL = "data/plugins/%40mulmoclaude%2Ftodo-plugin/todos.json";
const CALENDAR_DB_REL = "data/scheduler/items.json";
const ACCOUNTING_CONFIG_REL = "data/accounting/config.json";

test.describe("plugin dispatch (real LLM, one-turn canaries)", () => {
  test.skip(process.env.E2E_LIVE_NO_LLM === "1", "needs real LLM dispatch (fake-echo backend cannot route MCP tool calls)");

  test("L-DISPATCH-TODO: Personal role + manageTodoList が一ターンで dispatch される", async ({ page }) => {
    const marker = makeMarker("L-DISPATCH-TODO");
    await runDispatchCase(page, {
      testId: "L-DISPATCH-TODO",
      role: "personal",
      toolName: "manageTodoList",
      marker,
      prompt: [
        `Use the \`manageTodoList\` tool with action='add' to add one todo whose text is EXACTLY '${marker}' (verbatim, no edits).`,
        "Do not use show / list_labels / any other action. Do not use any other tool. Do not narrate the result.",
      ].join(" "),
      expectedAddAction: "add",
      cleanupPrompt: [
        `Now delete every todo whose text equals EXACTLY '${marker}'.`,
        "Use the manageTodoList tool with action='delete' (look it up via ToolSearch if needed).",
        "Do not narrate the result.",
      ].join(" "),
      expectedCleanupAction: "delete",
      markerScopedFile: { workspaceRel: TODO_DB_REL, matchField: "text" },
    });
  });

  test("L-DISPATCH-CAL: Personal role + manageCalendar が一ターンで dispatch される", async ({ page }) => {
    const marker = makeMarker("L-DISPATCH-CAL");
    await runDispatchCase(page, {
      testId: "L-DISPATCH-CAL",
      role: "personal",
      toolName: "manageCalendar",
      marker,
      prompt: [
        `Use the \`manageCalendar\` tool with action='add' to add a calendar event whose title is EXACTLY '${marker}' (verbatim) on 2099-12-31.`,
        "Do not use show / update / any other action. Do not use any other tool. Do not narrate the result.",
      ].join(" "),
      expectedAddAction: "add",
      cleanupPrompt: [
        `Now delete every calendar event whose title equals EXACTLY '${marker}'.`,
        "Use the manageCalendar tool with action='delete'.",
        "Do not narrate the result.",
      ].join(" "),
      expectedCleanupAction: "delete",
      markerScopedFile: { workspaceRel: CALENDAR_DB_REL, matchField: "title" },
    });
  });

  test("L-DISPATCH-MD: General role + presentDocument が一ターンで dispatch される", async ({ page }) => {
    const marker = makeMarker("L-DISPATCH-MD");
    await runDispatchCase(page, {
      testId: "L-DISPATCH-MD",
      role: "general",
      toolName: "presentDocument",
      marker,
      prompt: [
        `Use the \`presentDocument\` tool to render this markdown verbatim: '# ${marker}'.`,
        "Do not use any other tool. Do not narrate the result.",
      ].join(" "),
      // presentDocument is single-action (no `action` arg), so
      // expectedAddAction is undefined. No delete tool exists; the
      // saved `artifacts/documents/<YYYY>/<MM>/*.md` is a persistent
      // workspace artifact, identifiable by the marker in its body.
    });
  });

  test("L-DISPATCH-XLS: Office role + presentSpreadsheet が一ターンで dispatch される", async ({ page }) => {
    const marker = makeMarker("L-DISPATCH-XLS");
    await runDispatchCase(page, {
      testId: "L-DISPATCH-XLS",
      role: "office",
      toolName: "presentSpreadsheet",
      marker,
      prompt: [
        `You MUST call the \`presentSpreadsheet\` tool. Pass one sheet named EXACTLY '${marker}' (verbatim) with header [Month, Sales] and one row [Jan, 100].`,
        "Do not compose the table in text. Do not use presentChart, presentDocument, or any other tool. Do not narrate the result.",
      ].join(" "),
      // presentSpreadsheet has no delete tool — see L-DISPATCH-MD note.
    });
  });

  test("L-DISPATCH-SVG: Artist role + presentSVG が一ターンで dispatch される", async ({ page }) => {
    const marker = makeMarker("L-DISPATCH-SVG");
    await runDispatchCase(page, {
      testId: "L-DISPATCH-SVG",
      role: "artist",
      toolName: "presentSVG",
      marker,
      prompt: [
        `Use the \`presentSVG\` tool to render this SVG verbatim: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>${marker}</title><rect width="10" height="10" fill="red"/></svg>'.`,
        "Do not use any other tool. Do not narrate the result.",
      ].join(" "),
      // presentSVG has no delete tool — see L-DISPATCH-MD note.
    });
  });

  test("L-DISPATCH-HTML: Office role + presentHtml が一ターンで dispatch される", async ({ page }) => {
    const marker = makeMarker("L-DISPATCH-HTML");
    await runDispatchCase(page, {
      testId: "L-DISPATCH-HTML",
      role: "office",
      toolName: "presentHtml",
      marker,
      prompt: [
        `Use the \`presentHtml\` tool to render this HTML verbatim: '<!doctype html><html><body><h1>${marker}</h1></body></html>'.`,
        "Do not use presentDocument. Do not use any other tool. Do not narrate the result.",
      ].join(" "),
      // presentHtml has no delete tool — see L-DISPATCH-MD note.
    });
  });

  test("L-DISPATCH-ACCT: Accounting role + manageAccounting が一ターンで dispatch される", async ({ page }) => {
    const marker = makeMarker("L-DISPATCH-ACCT");
    await runDispatchCase(page, {
      testId: "L-DISPATCH-ACCT",
      role: "accounting",
      toolName: "manageAccounting",
      marker,
      prompt: [
        `Use the \`manageAccounting\` tool with action='createBook' to create a new book whose name is EXACTLY '${marker}' (verbatim), currency='USD', country='US'.`,
        "Do not call openBook / getBooks / any other action. Do not call openBook afterwards. Do not use any other tool. Do not narrate the result.",
      ].join(" "),
      expectedAddAction: "createBook",
      cleanupPrompt: [
        `Now delete the book whose name equals EXACTLY '${marker}'.`,
        "Use the manageAccounting tool with action='getBooks' first to find the bookId, then action='deleteBook' with confirm=true.",
        "Do not narrate the result.",
      ].join(" "),
      expectedCleanupAction: "deleteBook",
      markerScopedFile: { workspaceRel: ACCOUNTING_CONFIG_REL, arrayPath: "books", matchField: "name" },
    });
  });
});
