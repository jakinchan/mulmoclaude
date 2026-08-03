# fix(lint): `as` キャスト禁止を `error` に昇格して #2692 を閉じる

## 背景

#2692 は「CLAUDE.md が `as` を禁止しているのに ESLint が止めておらず、本体に 187 箇所ある」という issue。
`consistent-type-assertions` を `assertionStyle: "never"` で入れ、**`warn` のまま**段階的に潰してきた。

現状（実測）:

| 完了条件 | 状態 |
|---|---|
| `consistent-type-assertions` が `error` | **未** — 主ブロックは `warn`、drain 済み 10 パッケージだけ `error` |
| テストの扱いを決めて設定に書く | 済 — `test/**` 等は `assertionStyle: "as"` に緩和、理由付き |
| 残る例外が設定ファイルに理由付きで | **未** — 理由は書かれているが**インラインコメント**であって設定側の allowlist ではない |
| インライン `eslint-disable` が 0 件 | 済 — 0 件 |

残っている `as` は **8 箇所**（187 → 8、96% 削減）。すべて既に `Cast kept (#2692)` と理由が
コメントされた「不可避」判定済みで、潰す対象は残っていない。

## やること

1. 主ブロックを `warn` → **`error`**
2. Vue テンプレート側（`vue/no-restricted-syntax` の `TSAsExpression` セレクタ）も `warn` → **`error`**
3. **per-package の ratchet ブロックを削除** — 主ブロックが `error` になれば役目が終わるため
   （ブロック自身のコメントにも「repo-wide が graduate したら消す」と書いてある）
4. 残る 8 ファイルを **`eslint.config.mjs` の allowlist** に移し、1 エントリ 1 理由を書く

## 8 箇所とその理由

| ファイル | 理由 |
|---|---|
| `packages/core/src/remote-host/index.ts` | `Jsonify<T>` → `JsonObject` の唯一の広げ場所（8 ハンドラが各自で再論していたのを集約済み） |
| `packages/core/src/remote-host/server/hostRunner.ts` | `doc.data() as Command`。外すには公開済み `onExpire` の型を狭める＝破壊的変更 |
| `packages/plugins/accounting-plugin/src/server/io.ts` | 永続化された book は型より緩い（legacy `fiscalYearEnd: "Q1"`）。述語にすると既存 book が開けなくなる |
| `server/utils/files/json.ts` | 読んだファイルを同じ経路が書き戻すので、未知エントリを落とすとユーザーのデータが消える |
| `src/plugins/api.ts` | `E` は呼び出し側のジェネリック |
| `src/plugins/metas.ts` | アグリゲータで唯一「主張」する箇所。主張自体は `test_meta_aggregation.ts` が全 aggregator に対して検証 |
| `src/tools/runtimeLoader.ts` | `ToolDefinition.parameters` を証明するにはブラウザに JSON-Schema validator を積む必要がある |
| `src/utils/plugin/runtime.ts` | `T` はプラグインのもの。ペイロード検証はプラグインの責務 |

### allowlist の代償を明記する

ファイル単位で `off` にするので、**そのファイルに 9 個目の `as` が足されても検出されない**。
issue が「インライン `eslint-disable` を使わずに設定へ」と指定しているのでこの形にするが、
粒度が落ちることは設定コメントに書き、エントリは小さいファイルに限る。

## 検証

- `yarn lint` が **0 errors**
- **ゲートが実際に落ちることを壊して確認する**（設定を変えただけで「効いている」と主張しない）:
  - 通常のソースに `v as string` を足す → `error` が出ることを確認して戻す
  - Vue テンプレートに `($event.target as HTMLInputElement)` を足す → `error` が出ることを確認して戻す
- `yarn format` / `typecheck` / `build` / `test`
