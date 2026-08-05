# @mulmoclaude/markdown-plugin

Full-fidelity markdown document plugin (presentDocument) — Marp slides, PDF export, AI image-fill — shared gui-chat-protocol plugin for MulmoClaude and MulmoTerminal.

A plugin for [MulmoClaude](https://github.com/receptron/mulmoclaude) and [MulmoTerminal](https://github.com/receptron/mulmoterminal) — loaded by the host, not run standalone.

## Source-editor bookmarks

The **plain-document** source editor marks bookmarked places in a rail down its
left edge — a small clickable triangle per bookmark, positioned at that place's
position in the whole document. Clicking one scrolls the editor there.

Marp decks are excluded: a deck is navigated by slide, and its editor sits beside
a live slide preview that already says where you are.

What counts as a bookmark is a **regular expression** of your own, set once per
machine in `~/.config/mulmo/config.json` — the host-neutral config file shared by
MulmoClaude and MulmoTerminal, so both apps mark the same thing:

```json
{
  "documentBookmarks": {
    "pattern": "^\\.\\.\\."
  }
}
```

That is also the default when the file (or the key) is absent: a line beginning
with `...` is a bookmark. The pattern is compiled with the `m` and `g` flags, so
`^` and `$` mean line boundaries. Note that it is a regex source inside JSON —
backslashes are doubled, and a literal `.` needs escaping (bare `^...` would mean
"any three characters at line start", which matches nearly every line).

A pattern that does not compile, is empty, or is over 200 characters is ignored
in favour of the default; the rail is hidden entirely in documents with no
matches.

## Dev loop

```bash
yarn workspace @mulmoclaude/markdown-plugin run build
yarn workspace @mulmoclaude/markdown-plugin run test
```

## Related projects

Used by both MulmoClaude and MulmoTerminal, and published from the MulmoClaude monorepo by [Receptron](https://github.com/receptron).

- **[MulmoClaude](https://github.com/receptron/mulmoclaude)** — an open-source AI assistant platform that runs on your own computer. Claude Code as the engine, a personal wiki for long-term memory, schema-driven collections for your data, and chat that summons the right GUI (markdown, charts, forms, spreadsheets, wikis) for each task.
- **[MulmoTerminal](https://github.com/receptron/mulmoterminal)** — a terminal-first cockpit for running many AI coding agents in parallel. One roster showing every session's summary and PR status, tmux-backed session persistence, git-worktree isolation, one-click PRs, and mobile push with remote reply.
- **[MulmoTerminal manual](https://receptron.github.io/mulmoterminal/)** — setup, workflows, feature reference, configuration, mobile notifications, and alternative / local model providers. Available in English and Japanese.
