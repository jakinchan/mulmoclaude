# fix(agent): 「MCP server may have crashed」の誤検知をやめる（#2900）

## 問題

`server/agent/backend/claude-code.ts` の `createMcpTracker()` は、次の条件だけで
「MCP サーバがクラッシュしたかもしれない」と警告する。

```ts
if (toolSearchCalled && !mcpToolCalled) { log.warn("agent", "…may have crashed…"); }
```

ところが ToolSearch は **Claude Code CLI 組み込みの deferred ツール**
（`WebFetch` / `WebSearch` / `PushNotification` など）の解決にも使われる。これらは
`mcp__` プレフィックスを持たないので、**MCP が完全に健全でも条件が成立する**。

#2886 ではこの警告が出たことで、報告者が「MCP がクラッシュしている / socat リレーが原因では」
という誤った切り分けに進み、issue のタイトルにもその推測が入った。実際には MCP は健全で、
`notify, handlePermission, spawnBackgroundChat, manageCollection` が正常に publish されていた。

副次的に、警告が案内する `npx tsx --test test/agent/test_mcp_docker_smoke.ts` は
npm パッケージの `files` に `test/` が入らないため、`npx mulmoclaude` ユーザーには実行できない。

## 方針

推測（ツール名の形）ではなく、**ブローカーが ready を報告したかどうか**で判定する。
#2898 が入れた startup beacon（`server/agent/brokerReadiness.ts`）がその信号。

警告条件を次の3つの **AND** にする。

1. `mcpConfigured` — このターンが MCP 付きで構成された（`input.mcpConfigPath !== undefined`）。
   MCP 無しのターンで「MCP が来ない」と言っても意味がない。
2. `!aborted` — ユーザーがターンを止めていない。停止ボタンを押した直後は
   「MCP 構成あり・beacon なし・ツール0」が必ず成立するので、これが無いと
   **ごく普通のキャンセル操作で毎回誤検知する**（Codex review on #2906）。
   判定に使うのは `isAbortCausedExit` ではなく abort シグナルそのもの。
   ここで問うているのは「ターンが途中で切られたか」であって
   「この exit code が我々由来か」ではない。キャンセル後に CLI が exit 0 で
   きれいに終わるケースを `isAbortCausedExit` は通常終了として扱ってしまう。
3. `!brokerEverReady` — 現在の spawn の beacon が一度も届いていない（`getBrokerReady() === null`）。
4. `builtinMcpToolsCalled === 0` — **組み込みブローカーの**ツール（`mcp__mulmoclaude__*`）が1回も呼ばれなかった。

`mcp__*` 全体ではなく組み込み限定にするのが要点。`buildMcpConfig()` はユーザー定義 MCP サーバや
claude.ai コネクタを同じ config に登録するので、`mcp__github__*` が成功しただけで
「うちのブローカーは上がった」と誤って判定してしまう。beacon が語るのは組み込みブローカーだけ
（Codex review on #2906）。

### 4 を残す理由（新しい誤検知を作らないため）

beacon はブローカー → ホストへの POST なので、**beacon 自体が届かない環境がありうる**
（#2842 の報告者の socat リレー、firewalld 等）。beacon の不在だけで警告すると、
まさに元の報告を出した環境で新しい誤検知になる。

ツールが実際に動いていれば、beacon が落ちていてもブローカーは仕事をしている。
だから「beacon が無い」かつ「ツールも1つも動いていない」を要求する。

逆に #2886 のケース（ToolSearch で `PushNotification` / `WebFetch` を引いた健全なターン）は
beacon が届いているので 2 で落ちる。**旧ヒューリスティックの誤検知はこれで消える。**

### ToolSearch は判定から完全に外す

「ToolSearch が呼ばれたか」は MCP の健全性と無関係なので、追跡自体をやめる。

## 変更

| ファイル | 変更 |
|---|---|
| `server/agent/backend/claude-code.ts` | `createMcpTracker` を廃止し、組み込みブローカーの呼び出しだけ数える watcher + 純粋な判定関数 `shouldWarnMcpUnavailable()` に置き換え。警告文を npm 版でも実行できる案内に差し替え |
| `server/agent/activeTools.ts` | `BUILTIN_MCP_TOOL_PREFIX`（`mcp__mulmoclaude__`）を export |

`readAgentEvents()` に `chatSessionId` と `mcpConfigured` を渡す必要がある
（呼び出し元 `runClaudeAgent` は `input.sessionId` / `input.mcpConfigPath` を持っている）。

判定は純粋関数として export し、単体テストで固定する（`docs/testing.md` の
designing-for-testability に従う）。

## テスト

`test/agent/test_mcpUnavailableWarning.ts`（新規）:

- MCP 未構成 → 警告しない
- beacon あり / ツール0 → 警告しない（**#2886 の回帰ケース**: ToolSearch で組み込みを引いた健全なターン）
- beacon なし / ツールあり → 警告しない（beacon が落ちる環境の保護）
- beacon なし / ツール0 → 警告する
- **キャンセルされたターン → 警告しない**（他の条件が全て揃っていても）
- watcher が `mcp__mulmoclaude__*` だけを数え、`WebFetch` / `ToolSearch` / `PushNotification` も
  `mcp__github__*` / `mcp__claude_ai_Gmail__*` も数えないこと
- 非組み込み MCP だけが応答 + beacon なし → **警告する**

## 検証

`yarn format` → `yarn lint` → `yarn typecheck` → `yarn build` → `yarn test`。

判定は純粋関数なので単体テストで足りるが、`readAgentEvents` のシグネチャを変えるため
**実際にターンを1回回して**、健全なターンで警告が出ないことを確認する。

## やらないこと

`packages/core/assets/helps/error-recovery.md` は触らない。これは既存の診断の条件を
直すもので、新しい失敗モードを足すものではない。かつ `assets/helps/*` を変更すると
`@mulmoclaude/core` の publish が要る。必要なら別 issue にする。

refs #2900
