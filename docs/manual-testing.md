# Manual Testing Guide

Things that E2E (`yarn test:e2e`) **cannot** cover reliably, and must be
checked by hand before a release or after a change that touches the
relevant area.

The goal of this doc is to keep the list of "manual-only" responsibilities
*finite and maintained* — if something moves into E2E coverage, strike it
out; if a new thing proves untestable, add it here with a reason.

> **Contributor note**: any PR that deliberately leaves a scenario uncovered
> by E2E (because the testing framework can't reach it) **must add an entry
> here** with the scenario, the reason it's untestable, and how to smoke-check
> it. See [CLAUDE.md → Manual Testing](../CLAUDE.md#manual-testing) for the
> workflow contract.

---

## 1. Drag-and-drop interactions

**Why manual**: `vuedraggable` wraps `Sortable.js`, which relies on native
HTML5 drag events. Playwright's synthetic mouse events (`page.mouse.down/move/up`,
`page.dragTo()`) don't trigger `dragstart` reliably on Sortable's listeners,
and the library's internal clone-swap isn't visible through standard DOM
assertions even when the drag does fire. Attempts consistently flake.

### What to check

| Surface | Flow |
|---|---|
| **Todo Kanban — card between columns** | Open `todos/todos.json`, drag a card from one column to another, verify it lands in the drop target + refreshes with the new status |
| **Todo Kanban — card reorder within column** | Drag a card up/down inside the same column, verify the new order persists after refresh |
| **Todo Kanban — column reorder** | Drag a column header sideways, verify `order` persists |

**Server contract is already covered**: `POST /api/todos/items/:id/move` is
exercised by the list-view checkbox toggle test in
`e2e/tests/todo-items-crud.spec.ts`, so the API wiring is not in question —
only the UI wiring of the drag itself.

## 2. Canvas-based UI

**Why manual**: HTML `<canvas>` pixel state isn't accessible to Playwright's
assertion APIs in a deterministic way (`getImageData` needs the test to
understand the exact pixel layout, which is brittle to rendering differences
across OS/GPU).

### What to check

- **Image plugin — draw to canvas**: enter a canvas view, draw with the
  brush, verify strokes appear visibly
- **Image plugin — save after drawing**: click Save, verify the image
  persists (reopen the session → image reloads with strokes intact)
- **Style application**: apply a style preset, save, reopen → style stays

## 3. Iframe-sandboxed content rendering

**Why manual**: `presentHtml` (and any future HTML rendering plugin) uses a
CSP-sandboxed iframe. Playwright can see the iframe element exists but
can't introspect content behind the sandbox boundary, and auto-height
sizing relies on the iframe's own `load` event firing against its rendered
document.

### What to check

- **Stack view — presentHtml natural height**: a multi-screen HTML result
  should expand to its full content height, no inner scrollbar. Same for
  `presentDocument` / `presentSpreadsheet` / `manageWiki`.
- **Single view — iframe scroll**: long HTML scrolls internally without
  breaking the host page layout.

## 4. LLM + agent driven flows (require real backend)

**Why manual**: E2E mocks `/api/agent` entirely. Anything that exercises
the Claude CLI + MCP + real file system side effects needs an actual
`yarn dev` run.

### What to check after changes to agent / MCP / plugins

- **Session jsonl contents**: inspect `~/mulmoclaude/chat/<id>.jsonl`
  after a turn, verify:
  - User + assistant text appended
  - `tool_call` and `tool_call_result` records present (tool-trace #195)
  - WebSearch results stored as `contentRef` to `workspace/searches/*.md`,
    not inline base64
- **Wiki backlinks**: after a turn that creates/edits a wiki page, the
  page ends with `<!-- journal-session-backlinks -->` + a `## History`
  section linking to the originating `chat/<id>.jsonl` (#193)
- **Workspace artifact pointers**: image plugin saves to
  `workspace/images/<hash>.png` and the tool result carries the path, not
  base64; wiki pages reference images via path, not base64
- **Role switching**: switch role mid-session → context resets, correct
  MCP tool palette loads (check `claude mcp list` output)
- **Journal daily pass**: run with `JOURNAL_FORCE_RUN_ON_STARTUP=1` and
  verify `workspace/summaries/daily/YYYY/MM/DD.md` gets written
- **Stale `claude --resume` fail-over (#211)**: open an existing session,
  edit `~/mulmoclaude/chat/<id>.json` to set `claudeSessionId` to a
  random UUID the CLI has never seen. Send a message and verify:
  (a) a status event "Previous session unavailable — continuing with
  local transcript." surfaces in the UI, (b) the assistant reply
  arrives and makes sense given the transcript, (c) after the turn
  `chat/<id>.json` carries a fresh `claudeSessionId` (the new one
  issued by the retried run), and (d) a follow-up turn resumes
  cleanly on the new id. E2E is skipped here because faking the
  Claude CLI's stderr across a real subprocess is brittle; the stale
  detection + preamble construction are unit-tested in
  `test/agent/test_resumeFailover.ts`.

## 5. Log output (not asserted by E2E)

**Why manual**: the file-sink log goes to `server/system/logs/` and is not
wired into the test assertions. Spot-checking is usually enough.

### What to check after logger changes

- **Startup**: `yarn dev` → console shows `[workspace] / [sandbox] /
  [mcp] / [server] / [task-manager]` info lines at normal ISO timestamps
- **Agent path**: `server/system/logs/server-YYYY-MM-DD.log` contains `[agent]`
  request received / completed / CLI stderr line-by-line entries
- **Tool-trace**: `[tool-trace] web_search starting` + `web_search saved`
  pair for a WebSearch turn; debug-level entries visible only under
  `LOG_CONSOLE_LEVEL=debug`
- **CSRF reject**: hit the server from a non-localhost Origin →
  `[csrf] rejected cross-origin request` warn entry

See [`docs/logging.md`](logging.md) for the full logger reference.

## 6. Editor save-failure UX (markdown + presentMulmoScript)

**Why manual**: an E2E that mocks `PUT /api/markdowns/:file` or
`POST /api/mulmo-script/update-beat` with a 500 proved flaky when run
alongside the rest of the presentMulmoScript suite — the mocked
request was occasionally unobserved even though the test passed in
isolation. The fix is exercised by the same flow in production; the
manual smoke below is enough to catch a regression.

### What to check

| Surface | Flow |
|---|---|
| **markdown plugin edit** | Open a markdown tool result → "Edit Markdown Source" → change text → disconnect network (devtools) → click "Apply Changes". Editor stays open, a red "Save failed: …" box appears, editor content unchanged. Reconnect + retry succeeds. |
| **presentMulmoScript beat edit** | Open a MulmoScript tool result → "Show source" on a beat → change JSON → disconnect network → click "Update". Editor stays open, red "Save failed: …" inline message near Update, JSON unchanged. Reconnect + retry succeeds. |

**Server contract is already covered**: the render-beat 500-path E2E
exercises the same `{ error }` response shape — only the *editor UI
wiring* on save failure needs manual verification.

## 7. Accounting plugin (test rollout)

**Why manual**: the accounting plugin is opt-in. The default
(General) role doesn't expose it, no `/accounting` route exists, no
PluginLauncher button. The built-in **Accounting** role surfaces it
via the role picker; custom roles that list `manageAccounting` in
their `availablePlugins` work too. The E2E isolation test asserts
the General role still doesn't see the plugin; the positive flow
needs a human walking through real journal data.

### Setup

Pick the entry point that matches what you're testing:

- **Recommended**: switch to the built-in **Accounting** role from
  the role picker. The role exposes `manageAccounting`,
  `presentForm`, and `presentDocument` — enough for the bookkeeping
  flow with structured user prompts.
- **Custom role (legacy / advanced)**: `/roles` → "New role" → in
  the plugin picker, check `manageAccounting` (the picker
  auto-populates from `TOOL_NAMES`). Useful when you want a
  different plugin mix than the built-in role ships.
- **File-edit (legacy / advanced)**: drop a JSON role definition
  into `~/mulmoclaude/config/roles/<your-id>.json` containing
  `{"id":"<your-id>","label":"<Label>","availablePlugins":["manageAccounting"]}`
  and restart the server.

In every case, switch to the role in the role picker. Claude can
then call `manageAccounting` and the `openBook` action mounts
`<AccountingApp>`.

### Smoke checklist for a fresh book

Run on a workspace with no `data/accounting/` directory yet:

1. Open the app via Claude (`"open my books"` is enough). The empty
   state appears with the New Book modal auto-opened.
2. Create a book — confirm the directory is
   `~/mulmoclaude/data/accounting/books/book-XXXXXXXX/` (8-hex-char
   id, **not** `default/`).
3. Set opening balances. Confirm the save button stays disabled
   until Σ debit = Σ credit.
4. Add an income entry (credit Sales 200, debit Cash 200) and an
   expense entry (debit Rent 70, credit Cash 70). Both appear in
   the journal list.
5. Balance Sheet totals balance. P/L net income matches the entries.
6. Create a second book; switch via the BookSwitcher. Journal list
   contents change.
7. Delete the non-active book. Active book stays.
8. **Last-book deletion**: delete the remaining book. The empty
   state reappears, the New Book modal auto-opens. Re-create a book
   and confirm the BookSwitcher shows just the new id.

### Recovery drills

- **Stale snapshot**: hand-delete a snapshot file
  (`~/mulmoclaude/data/accounting/books/<id>/snapshots/YYYY-MM.json`)
  and request a Balance Sheet for that month. The lazy fallback
  rebuilds it on read; the report is correct; the file reappears.
- **`rebuildSnapshots` admin action**: from the settings tab, click
  the rebuild button. Watch the server log for one
  `snapshot rebuild started bookId=… fromPeriod=…` line and one
  `snapshot rebuild done bookId=… periods=N` line.
- **Async rebuild during normal writes**: tail the server log
  (`yarn dev` output), add a journal entry. Confirm exactly one
  start/done pair per write burst. Fire five entries rapidly and
  confirm at most two start/done pairs — the queue coalesces.
- **Corrupt JSONL line**: edit a `journal/YYYY-MM.jsonl` by hand,
  inserting an invalid line. Reload the journal list — the parser
  skips that line with a warning, the rest of the month still shows.

### Void rendering

- Add a normal entry, then click "void" on its row. A single dialog
  prompts for a reason. Cancelling leaves the entry. Re-clicking,
  entering a reason, submitting — the original row gets the
  strikeout, the new void / void-marker rows render without
  strikeout. The voiding entry's memo reads
  `void of '<original memo>' on <original date>` (or `void of entry
  on <date>` if the original carried no memo).

### Soak

Developers running personal books: aim for 1–2 months of real
bookkeeping before considering GA flip. Track issues you hit (data
shape changes, surprising error states, performance) on the GA-flip
PR's checklist.

## 8. Cross-browser / responsive (beyond Chromium)

**Why manual**: E2E runs only Chromium (see `e2e/playwright.config.ts`).

### What to check before a release

- Safari / Firefox smoke: app loads, sessions list, sending a message, file
  explorer expands, no console errors
- Window resize: sidebar collapses / re-expands, canvas view scales

---

## 9. Browser page translation (`translate="no"` / `translate="yes"`)

**Why manual**: Chrome's built-in translation is a browser feature, not page
JavaScript — Playwright cannot switch it on, and there is no DOM signal to
assert against. The attribute placement is unit-guarded
(`test/components/test_translate_guard.ts`), but whether the *browser* honours
it can only be seen by hand.

Background: Material Icons draw glyphs from **ligatures**, so an icon element's
text content is the icon name. Translation rewrites those text nodes and every
icon-only control renders its name as a word (#2561 / #2558). `#app` carries
`translate="no"`; agent/user content opts back in with `translate="yes"`.

### What to check

Open the app in Chrome, right-click → **Translate to <other language>** and pick
a target language (changing Chrome's UI language does not translate the page on
its own). Pick a language different from `VITE_LOCALE` so the effect is visible.

| Surface | Expected |
|---|---|
| Header nav, sidebar rows, chat composer buttons | Icons stay as **glyphs**; no `send` / `lightbulb` / `送信` / `電球` text, no doubled labels |
| Teleported UI (file-tree context menu, confirm dialog, collection record modal) | Same — these render outside `#app`, so they carry their own `translate="no"` |
| Assistant reply body, wiki page body, skill body | **Do** get translated — these are `translate="yes"`, and losing that is the silent regression to watch for |

Nested `translate="yes"` inside a `translate="no"` subtree is per spec, but
Chrome's behaviour here is the reason this check exists: if content stops being
translatable, the opt-in is not being honoured and the approach needs revisiting
(per-icon `translate="no"` was the alternative — see #2561).

---

## 10. Google Tasks — reopening a completed task (`tasksUncomplete`, #2574)

**Why manual**: the unit tests stub `fetch`, so they pin what we *send*
(`{ status: "needsAction" }`) but say nothing about what Google *does* with it.
Asserting the real round-trip needs a live OAuth token and a real task list.

Background: `uncompleteTask` PATCHes `status` alone, mirroring `completeTask`.
Google is expected to clear the `completed` timestamp on its own when status
leaves `completed` — **this is unverified**. `TaskSummary` doesn't carry
`completed`, so a stale one would never show in MulmoClaude; it would only be
visible in Google's own UI.

### What to check

1. Ask the agent to create a task, then to complete it.
2. In Google ToDo (or Calendar's task pane), confirm it shows as done.
3. Ask the agent: "put that task back on my list" → `tasksUncomplete`.
4. In Google's UI, confirm the task is back on the list **and does not show a
   completion date**.

If a completion date lingers, add `completed: null` to the patch body in
`packages/core/src/google/tasks.ts` — the comment on `uncompleteTask` marks the
spot.

Also worth one pass: ask to reopen a task *without* listing first. The tool
description tells the model to list with `showCompleted: true` (completed tasks
are hidden by default), so the failure to watch for is the agent reporting "no
such task" instead of finding it.

---

## 11. Icon launcher — the parts of a double-click no harness reaches (#2613)

**Why manual**: `create-shortcut` and every decision the launcher makes are
unit-tested, and `test/utils/launcher/test_resolvePath.ts` runs the PATH
recovery under the stripped environment a GUI launch really gets. What no test
can do is *be a person double-clicking an icon in the Finder* — LaunchServices,
icon rendering, and a modal `osascript` alert are outside any runner.

Note that `open MulmoClaude.app` **from a terminal is not a substitute**: it
leaks the terminal's environment to the app (measured: 59 env vars and a full
`PATH`), so it passes even when a real double-click would fail. The closest
scriptable approximation is
`env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin open -n MulmoClaude.app`.

### What to check

Build it first: `npx mulmoclaude create-shortcut`.

1. **The icon looks right** in the Finder and in the Dock — a grey rounded
   square with a white M, not the generic app icon. A generic icon means
   `buildIcns` failed (it degrades instead of aborting).
2. **Double-click with nothing running** → a progress page appears within a
   second or two, and the app replaces it when the server is up.
3. **Double-click while MulmoClaude is already running** → the browser opens
   straight to the app. No second server: `lsof -ti:3001` still shows one PID.
4. **Quit the terminal you installed from, then double-click again.** This is
   the case that catches a PATH regression on a machine using a version manager.
5. **Node.js missing** (test on a machine without it, or temporarily rename the
   binary): a native alert appears with the "nodejs.org" button, and clicking it
   opens the download page. This is the only screen that cannot be a web page,
   so it is also the only one whose button cannot be tested.
6. **System language** — switch macOS to another supported language, log out and
   in, and confirm the progress page and any error page follow it. Simplified
   Chinese is the one worth picking: it reports `AppleLocale = zh-Hans_US`, a
   script-tagged form that no other supported language produces.

The launcher's own log is `~/Library/Logs/MulmoClaude/launcher.log`.

---

## 12. Windows icon launch (`create-shortcut`)

Most of this section used to be here. It is now in CI, because the *cause*
of each failure turned out to be checkable even where the appearance is not
— see `test/utils/launcher/test_windowsShortcutIntegration.ts`:

| Was manual | Now asserted on `windows-latest` |
|---|---|
| The icon renders | Every size decodes out of the `.ico` and has opaque pixels — a blank icon fails |
| SmartScreen stays quiet | None of the generated files carries a `Zone.Identifier` stream, which is the attribute SmartScreen keys on |
| A version-manager node resolves | The real `launch.vbs` runs with node reachable only through an nvm-like PATH entry, and the handover names that node |
| No console window | The stub is asserted never to call `WshShell.Exec` (which always allocates a console) and to run node with `Run(…, 0, False)` |

**What is still human, and cannot stop being:**

1. **What it looks like.** That the icon is the right artwork at each size,
   that the progress page is legible, that the `MsgBox` is readable. CI can
   prove pixels exist; it cannot prove they look right.
2. **The gesture.** A real Explorer double-click, and the Start Menu entry
   appearing under a search for "MulmoClaude".
3. **A genuinely unsigned-app-hostile machine.** The Mark-of-the-Web check
   covers the documented mechanism, but a machine under managed policy can
   refuse unsigned apps on grounds CI has no way to reproduce.
4. **The no-Node dialog end to end.** Rename node, double-click, confirm the
   `MsgBox` appears in the system language and that **Yes** opens nodejs.org.
   A modal on a headless runner would hang the job, so it is never fired
   there.

The launcher's own log is `%LOCALAPPDATA%\MulmoClaude\logs\launcher.log`.

---

## Updating this document

When you land a PR:

1. If the change adds E2E coverage for a scenario previously listed here →
   **remove** the entry (or strike it through with a link to the covering
   test).
2. If the change introduces a new UI surface or backend behaviour that
   E2E can't reach → **add** an entry with the flow + the reason it's
   untestable.
3. Keep this doc focused on *persistent* manual-test obligations, not
   per-PR smoke-test notes (those belong in the PR description).

The enforcement is on the honour system — no automation ensures this doc
stays current. But it's the only place that keeps the out-of-E2E surface
from silently growing, so treat entries here as first-class test
artifacts.
