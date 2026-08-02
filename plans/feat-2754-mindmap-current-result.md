# feat(mindmap): セッションの直近 mindmap 結果を `context.currentResult` として渡す (#2754)

## Request

MulmoClaude では `execute()` はクライアントで呼ばれず、プラグイン呼び出しは全て `/api/mindmap` 経由。
そのサーバ経路の context は `SERVER_TOOL_CONTEXT = Object.freeze({})` で **`currentResult` が常に空**なので、
`add_node` / `delete_node` / `connect` / `update` / `rebalance` が**編集対象のマップを見つけられない**。

`1074ed0e3`（`null as never` → `Object.freeze({})`）で #2709 の 500 は消えたが、症状が
「500」から「マップが無い」に変わっただけで、機能としては動かないまま。

プラグイン側は `@gui-chat-plugin/mindmap@1.2.0` として publish 済み
（receptron/GUIChatPluginMindMap#30）── ID とラベルの両方でノード解決できるようになったので、
**ホスト側で `currentResult` さえ渡れば動く**。

## いま何が起きているか（コードで確認した経路）

```
MCP bridge  ──postJson(/api/mindmap?session=<id>)──▶  plugins.ts
                                                       executeMindMap(SERVER_TOOL_CONTEXT, body)
                                                       └─ currentResult: undefined  ← ここ
              ◀── result ──
MCP bridge  ──postJson(/api/agent/internal/toolResult?session=<id>)──▶ agent.ts
                { ...result, toolName: "createMindMap", uuid }
                                                       pushToolResult(sessionId, body)
                                                       └─ JSONL 追記 + セッション channel へ publish
```

- `result.data !== undefined` のときだけ push される（`mcp-server.ts` のレンダリング判定）
- `toolName` は**ブリッジが権威的に上書き**するので信用できる
- 呼び出し順は「実行 → レスポンス → toolResult push」なので、**次の呼び出し時には直前の結果が入っている**

## 方針

**session-store に「toolName ごとの直近 ToolResult」をメモリで持つ。** issue の提案どおり
JSONL 全読みはしない（起動直後や大きなセッションで重く、しかも `data` を持たない結果は
そもそも JSONL に無い）。

### 置き場所

`ServerSession` に `latestToolResults: Record<string, ToolResult>` を足し、`pushToolResult` が
書くときに一緒に更新する。**push 経路は1本しかない**ので、ここに置けば取りこぼしがない。

- 保持は **toolName ごとに1件**。ツール数で上限が決まるのでセッションあたりの増加は有界
- セッションが evict されれば一緒に消える（既存のライフサイクルに乗る）

### 読み出し

`server/utils/request.ts` の `getSessionQuery(req)` でセッション ID は既に取れる。
`latestToolResult(chatSessionId, toolName)` を session-store から export し、
mindmap ルートで `{ currentResult }` を組み立てて渡す。

### 全プラグインに配るか、mindmap だけか

**メカニズムは汎用にし、配線は mindmap だけにする。**

- `latestToolResult()` は toolName を取る汎用 API。他のルートが必要になったら1行で使える
- しかし**今すぐ全ルートに配ることはしない**: `wrapPluginExecute` は toolName を知らないし、
  他のプラグインが「直前の結果」を渡された前提で書かれているかは未検証。
  渡して壊れないことを確認していないものに配るのは、直したい不具合と同じ種類の推測になる

## 実装

1. `ServerSession` に `latestToolResults: Record<string, ToolResult>`（初期値 `{}`）
2. `pushToolResult` が、結果に文字列 `toolName` があればそこへ記録
3. `latestToolResult(chatSessionId, toolName): ToolResult | null` を export
4. `plugins.ts` の mindmap ルートで、`getSessionQuery(req)` + `TOOL_NAMES.createMindMap` から
   context を作って `executeMindMap` に渡す。セッションが無い / 結果が無い場合は
   **今までどおり空 context** にフォールバック（`{}` は有効な context）
5. `@gui-chat-plugin/mindmap` を `^1.1.0` → `^1.2.0` に bump

## 判断が要る点（PR に書く）

- **`data` を持たない結果は push されない** ＝ `latestToolResults` にも入らない。mindmap の
  create は `data` を持つので実用上は問題ないが、「直近」の定義が「直近の**描画された**結果」で
  あることは明示する
- **セッションを跨がない**。別セッションのマップは見えない（意図どおり）
- **プロセス再起動で消える**。JSONL には残るが、メモリの直近キャッシュは復元しない ──
  復元するなら JSONL 読みが必要で、それは今回避けている選択そのもの

## テスト

- `pushToolResult` が `toolName` 付きの結果を `latestToolResults` に記録すること
- `toolName` が無い / 文字列でない結果は記録しないこと（壊れた入力で落ちない）
- 同じ toolName の2回目が1回目を置き換えること
- 別 toolName が互いを上書きしないこと
- `latestToolResult` が未知のセッション / 未知の toolName で `null` を返すこと
- mindmap ルートが、セッションに結果があるときは `currentResult` を渡し、無いときは空 context を渡すこと
