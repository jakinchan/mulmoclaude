# fix(logging): MCP ブローカー子プロセスのログに発生源を付ける（#2904）

## 問題

`loadPresetPlugins()` の呼び出し元は2箇所ある。

- `server/index.ts` — 親サーバの起動時に1回
- `server/agent/mcp-server.ts` — MCP ブローカーの子プロセス（**ターンごとに spawn**）

両者は同じログファイルに、**完全に同一の行**を書く。

```json
{"time":"…","level":"info","prefix":"plugins/preset","message":"loaded","data":{"requested":3,"succeeded":3}}
```

`plugins/preset loaded` に限らず、ブローカー子プロセスが出す**すべての行**が親サーバのものと区別できない。#2886 では報告者がこれを「サーバが数分おきに再起動している」と読み、バグ報告の主要な根拠の1つになった。実際は40分で9ターン実行されただけだった。

## 方針

ログレコードに **発生源（source）** を持たせ、親サーバ以外のプロセスが自分を名乗る。

- ロガーは source を**不透明な文字列として運ぶだけ**にする。MCP を知らせない（層の分離）。
- 発生源の合成は、spawn 元の `server/agent/config.ts` が行う。
- 親サーバは source を持たない（既存の全行のシェイプを変えない）。非デフォルトのプロセスだけが名乗る。

env 経由で渡す。ブローカーの env には既に `LOG_CONSOLE_STREAM: "stderr"` が同じ理由（stdout が JSON-RPC）で入っているので、その隣に置く。

### spawn id を source に含めない判断

`MCP_SPAWN_ID` は `makeUuid()` の 36 文字。これを全行に付けると text ログが読めなくなる。
かつ「40分に9回 = 9 spawn か1プロセスのループか」の判別は、#2898 が入れた
`log.info("mcp", "broker ready", { …, spawnId })`（`server/api/routes/mcpBrokerReady.ts:74`）が
spawn ごとに1行出すので既に可能。この issue の残課題は**親と子の区別**なので、
source は `mcp-broker` 固定でよい。

## 変更

| ファイル | 変更 |
|---|---|
| `server/system/logger/types.ts` | `LogRecord.source?: string` |
| `server/system/logger/config.ts` | `LoggerConfig.source?: string`、`resolveConfig` が `env.LOG_SOURCE` を読む（trim して空なら undefined） |
| `server/system/logger/index.ts` | `createLogger` が全レコードに `source` を載せる |
| `server/system/logger/formatters.ts` | text: level と prefix の間に `[source]`／json: `source` フィールド（どちらも source が無ければ従来どおり） |
| `server/agent/config.ts` | ブローカーの env に `LOG_SOURCE: "mcp-broker"` |
| `docs/logging.md` | `LOG_SOURCE` と、ブローカー子プロセスの行の読み方 |

出力例（text）:

```text
2026-08-14T09:00:47.172Z INFO  [mcp-broker] [plugins/preset] loaded requested=3 succeeded=3
2026-08-14T09:00:47.180Z INFO  [plugins/preset] loaded requested=3 succeeded=3
```

## テスト

- `test/logger/test_formatters.ts` — text / json / color 各フォーマットで source あり・なし
- `test/logger/test_logger.ts` — `createLogger({ source })` が全レコードに載せること
- `test/logger/test_loggerConfig.ts`（既存があればそこに追記） — `LOG_SOURCE` のパース（未設定 / 空文字 / 空白のみ / 通常値）
- `test/agent/` のブローカー env テスト — `LOG_SOURCE: "mcp-broker"` が env に入ること

## 検証

`yarn format` → `yarn lint` → `yarn typecheck` → `yarn build` → `yarn test`。

加えて **実際にターンを回して**、同じログファイルに `[mcp-broker]` 付きの行と付かない行が
両方現れることを確認する（build が通っただけでは、broker の env に届いたことを保証しない）。

refs #2904
