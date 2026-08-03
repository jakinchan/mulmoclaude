# fix #2789 — 一時ディレクトリを消さないテストを直す

## 問題

テストが `mkdtemp` で作った一時ディレクトリを一度も消していない。**フルスイート1回で約208ディレクトリ**が
`$TMPDIR` に残り、実測でこのマシンには 1,072,016 件溜まっていた(ディレクトリ inode 33.8MB、
`ls $TMPDIR` が 2 分で返らない、readdir 5.4 秒)。

計測方法: 繰り返されたスイート実行を mtime で run 単位に区切り(60 秒以上の間隔を run の境界とみなす)、
prefix ごとの中央値を取った。12〜18 run 分のデータがある。

## 対象: 22 ファイル / 45 箇所

`mkdtemp` / `mkdtempSync` を呼ぶが `rmSync` を一度も呼ばないファイル。

- host (`test/`) 17 ファイル
- `packages/core/test/feeds/` 4 ファイル
- `packages/plugins/mulmoscript-plugin/test/` 1 ファイル

## 方針: 作った側が自動で片付ける helper に一本化する

呼び出しを `makeTempDir(prefix)` に置き換えるだけで済む形にする。1 箇所 1 行の変更で、
テストのロジックには触らない — 45 箇所を触るので、変更の形は最小かつ機械的であることが重要。

```ts
export const makeTempDir = (prefix: string): string => { ... }  // 作成 + 後始末の登録
```

後始末は **プロセス終了時**に行う。`tsx --test` (node:test) は
**テストファイル 1 本につき 1 プロセス**を起動するので、exit フックひとつで
モジュールスコープ・`before()`・テスト内、どこで作られたものも等しく回収できる。
`after()` フックだと登録タイミングがファイルごとに変わるが、exit なら一様になる。

`rmSync` は同期なので `process.on("exit")` から呼べる(非同期 API は exit フックでは完了しない)。

### helper を 3 つ置く理由(DRY の例外)

パッケージ境界を越えてテスト helper を import すると、`packages/core` が host の `test/` に
依存することになり、CLAUDE.md の依存方向(host → plugins → core、逆流禁止)に反する。
テスト専用のコードを publish 対象の `@mulmoclaude/common` に入れるのも筋が悪い。
よって helper は test root ごとに置く:

- `test/helpers/tempDir.ts`
- `packages/core/test/helpers/tempDir.ts`
- mulmoscript-plugin は 1 箇所だけなので helper を作らず、そのファイル内で完結させる

いずれも `test_*.ts` に match しないファイル名にする(各 workspace の test script は
`tsx --test test/**/test_*.ts` 形式なので、helper がテストとして実行されないようにするため)。

## 検証

- 修正前後で `$TMPDIR` のエントリ数の増分を実測し、**208 → 0** になることを確認する
  (自分の出力どうしの比較ではなく、実際のディレクトリを数える)
- `yarn test` フルスイートが緑のままであること(後始末を足したことでテストが壊れていないか)
- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build`

## やらないこと

- **`yarn--*`(約53万件)** — Yarn Classic 自身の残骸で原因が別。この PR の対象外。
- **mulmoterminal 側** — 同じ問題だが別リポジトリ。receptron/mulmoterminal#1345 に起票済み。
  あちらは共有 helper `test/support/tempDir.ts` 自体が後始末を持たないのが根本原因。
