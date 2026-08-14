# fix(web-push): 完了 push が「何が終わったか」を伝えるようにする（#2901）

## 問題

完了 push の本文は `meta.firstUserMessage` — **そのチャットの一言目**で固定されている。

```ts
// server/agent/webPush.ts
body: truncate((firstUserMessage ?? "").trim() || DEFAULT_BODY, PUSH_BODY_MAX),
```

`firstUserMessage` は `server/utils/files/session-io.ts:109` で一度書かれたら二度と上書きされない。
これ自体は正しい（サイドバーのチャット識別子としての用途で、`sessionsroutes.ts:135` が使っている）。

誤りは **それを push 本文に流用したこと**。`firstUserMessage` が答えるのは「どのチャットか」で、
通知が答えるべき「何が終わったか」ではない。結果、38ターンのセッションでは同じ文面が38回飛ぶ。
1ターン目だけ偶然正しく見え、**2ターン目から壊れる**。

## 却下した案

**直近のユーザー入力を本文にする** — 「はい」「OK」「続けて」で終わるターンが実際に多く、
`✅ MulmoClaude / はい` という無内容な通知になる。`firstUserMessage` と同じ
「ユーザーの発話を本文にする」発想の産物で、病気が治らない。

**セッションの AI タイトルだけを本文にする** — `MIN_INDEX_INTERVAL_MS = 15分` の
スロットル付きセッション単位なので、連続ターンでは結局同じ文面になる。`firstUserMessage`
より「マシ」なだけ。

## 方針

**title と body に別の情報を入れる。**

| | 内容 | 出どころ |
|---|---|---|
| title | ✅/⚠️ + **どのチャットか** | chat-index の AI タイトル → `firstUserMessage` → `"MulmoClaude"` |
| body | **何が終わったか** | そのターンのエージェント最終応答（markdown を平文化して切り詰め） |

```
✅ レンズDB の Firebase 連携
CSV に42件書き出しました。スキーマは既存の lenses コレクションに合わせています。
```

title のフォールバック順は `server/api/routes/sessions.ts:135` の
`indexEntry?.title ?? meta.firstUserMessage ?? ""` に合わせる（一覧の見た目と一致させる）。

### 最終応答はファイルを読まずに取れる

`server/api/routes/agent.ts` の `flushTextAccumulator` が、ターン中の text バーストごとに
`fullText` を組み立てて**そのまま捨てている**（`ctx.textAccumulator.length = 0`）。
ここで控えておけば jsonl を読み直す必要がない（長いセッションの全文読みは避けたい）。

flush はターン中に何度も走るので、最後の flush が最終応答。

`discardAbortedPass` でもクリアする — 失敗して replay されたパスのテキストが
再実行後の通知本文になってはいけない（既存の `textAccumulator` クリアと同じ理由）。

## 変更

| ファイル | 変更 |
|---|---|
| `server/api/routes/agent.ts` | `EventContext.lastAssistantText` を追加。`flushTextAccumulator` で記録、`discardAbortedPass` でクリア、`finalizeRun` → `notifyTaskFinished` へ渡す |
| `server/agent/webPush.ts` | `buildTaskFinishedPush` が title/body を別々に組む。新しい純粋関数 `condenseReplyForPush()` |
| `server/workspace/chat-index/indexer.ts` | `readIndexEntry(workspaceRoot, sessionId)` を export（per-entry ファイルを1つ読むだけ。`readIndexedAtMs` と同じ形） |

### `condenseReplyForPush()` の規則

通知1行に収めるための最小限。完全な markdown パーサは持ち込まない。

1. フェンス済みコードブロックを丸ごと削除
2. インラインコードのバッククォートを外す（中身は残す）
3. `[text](url)` → `text`
4. 行頭の `#`×1-6 / `>` / `-` / `*` / `+` / `N.` を削除
5. `**` / `__` を削除
6. 空白の連続を1つに畳んで trim
7. `PUSH_BODY_MAX` で切り詰め

正規表現は線形に保つ（このリポジトリは CodeQL の polynomial-ReDoS 指摘歴あり）。
ネストした量指定子を作らない。

空になったら `DEFAULT_BODY`（"Task complete"）にフォールバック。

## テスト

`test/agent/test_webPush.ts`（既存）に追加:

- title: AI タイトルあり / なし（`firstUserMessage` へ）/ どちらも無し（`"MulmoClaude"`）
- title: `didError` で ⚠️ に変わる
- body: **「はい」で終わるターンでも応答の内容が出る**（この issue の主眼）
- body: コードブロック / 見出し / リスト / リンクの平文化
- body: 応答が空（ツール実行のみ）→ `DEFAULT_BODY`
- body: 長文の切り詰め
- **同一セッションの2ターンで本文が変わること**（回帰の本体）

## 検証

`yarn format` → `yarn lint` → `yarn typecheck` → `yarn build` → `yarn test`。

加えて **実サーバでターンを2回回して**、`buildTaskFinishedPush` に渡る値を確認する。
2ターン目は「はい」のような無内容な入力にして、本文がそれではなく応答になることを見る。
push 自体は RemoteHost 未サインインだと送信されないので、使い捨ての計測で
渡り値を観測し、確認後に削除する。

refs #2901
