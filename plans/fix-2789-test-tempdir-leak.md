# fix #2789 — 一時ディレクトリを消さないテストを直す

## 問題

テストが `mkdtemp` で作った一時ディレクトリを一度も消していない。**フルスイート1回で約208ディレクトリ**が
`$TMPDIR` に残り、実測でこのマシンには 1,072,016 件溜まっていた(ディレクトリ inode 33.8MB、
`ls $TMPDIR` が 2 分で返らない、readdir 5.4 秒)。

計測方法: 繰り返されたスイート実行を mtime で run 単位に区切り(60 秒以上の間隔を run の境界とみなす)、
prefix ごとの中央値を取った。12〜18 run 分のデータがある。

## 対象: 25 ファイル / 65 箇所

- host (`test/`) 20 ファイル
- `packages/core/test/feeds/` 4 ファイル
- `packages/plugins/mulmoscript-plugin/test/` 1 ファイル

### 静的な監査だけでは 3 ファイル取りこぼした

最初は「`mkdtemp` を呼ぶが `rmSync` を一度も呼ばない」でファイルを抽出し、22 ファイル / 45 箇所とした。
これは **ファイル単位の判定なので、一部だけ後始末しているファイルを見逃す**。
隔離した `TMPDIR` でフルスイートを実際に流して残骸を数えたところ、次の 3 ファイルが漏れていた:

- `test/workspace/test_reference_dirs.ts` — `tmpRoot()` が作るディレクトリを `targets` に
  一度も push していない(`realDir()` だけが push していた)。実バグで、毎回確実にリークする。
- `test/workspace/wiki-pages/test_snapshot.ts` — 削除がアサーションの**後ろ**にあり、
  一部の経路で到達しない。
- `test/system/test_optionalDeps_degradation.ts` — `afterEach` で消しているが 1 個残る。

**「rmSync があるから大丈夫」は根拠にならない。数えるのが唯一の根拠**という教訓なので、
検証は必ず実測(下記)で行う。

## 方針: 作った側が自動で片付ける helper に一本化する

呼び出しを `makeTempDir(prefix)` に置き換えるだけで済む形にする。1 箇所 1 行の変更で、
テストのロジックには触らない — 65 箇所を触るので、変更の形は最小かつ機械的であることが重要。

一部だけ後始末していた 3 ファイルは、既存の削除処理を**残したまま** helper 経由にする。
通常経路は今までどおり即座に消え、失敗・例外で到達しなかった分を exit フックが拾う。

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
