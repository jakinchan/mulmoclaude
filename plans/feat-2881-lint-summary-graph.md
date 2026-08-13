# lint の結果をジョブサマリーにグラフで出す (#2881)

mulmoterminal の lint サマリー機構を移植する。

## なぜフォーマッタなのか（移植元の設計をそのまま引き継ぐ）

素直にやるなら CI に「lint の JSON を取ってグラフを作る」ステップを足すことになるが、
**eslint は1回の実行で1フォーマットしか出さない**ので、ログ用の `stylish` と集計用の
`json` で lint を2回走らせることになる。mulmoclaude の lint は Windows も含め決して速く
ないので、これは避けたい。

ESLint のカスタムフォーマッタにすれば、**既に走っている lint 1回**の結果を通りがけに
拾える。しかも `--format` はワークフローではなく `package.json` の `lint` に書くので、
`yarn lint` を呼んでいる3つのワークフロー（`pull_request.yaml` ×2、
`lint_test_windows.yaml`）は**1行も変更しなくてよい**。

`GITHUB_STEP_SUMMARY` が未設定のローカルでは何も書かないので、手元の `yarn lint` の
挙動は変わらない。ローカルで見たいときは `yarn lint:summary`。

## 移植するもの

| ファイル | 役割 |
| --- | --- |
| `scripts/lint-summary.mjs` | eslint の JSON → markdown。純粋関数（`renderReport` / `parseEslintJson`）なのでテストできる |
| `scripts/eslint-formatter-summary.mjs` | `stylish` をラップし `$GITHUB_STEP_SUMMARY` へ追記するフォーマッタ |
| `scripts/lint-summary.d.mts` | 上の手書き型。`.mjs` のままにするのは、eslint がフォーマッタを**ビルド無しで**読めるようにするため |
| `test/scripts/test_lint_summary.ts` | 移植元は vitest。mulmoclaude は node:test なので書き換える |

出力は「pie（area 別）＋ rule × area のクロス表＋ディレクトリ別 top15」。表には `█` のバー。

## 唯一の要調整点: `AREAS`

移植元は `["test","server","src","common","bin","scripts"]`。mulmoclaude の lint 対象は
`src server test e2e e2e-live packages scripts batch config` なので差し替える。

移植元のコメントどおり「大きい順」に並べる。実測のファイル数（`.ts` / `.vue` / `.mjs`、
`node_modules` と `dist` を除く）:

| area | files |
| --- | --: |
| `packages` | 1666 |
| `test` | 634 |
| `src` | 438 |
| `server` | 338 |
| `e2e` | 95 |
| `e2e-live` | 25 |
| `scripts` | 22 |
| `config` | 1 |
| `batch` | 1 |

`areaOf` は先頭セグメントの完全一致なので `e2e` と `e2e-live` は衝突しない。

### `packages` を1スライスにまとめる判断

`packages/` には約50 workspace がぶら下がっているが、**pie は `packages` 一括のままにする**。
50スライスの pie は読めないし、ディレクトリ表が深さ3で `packages/core/src` /
`packages/plugins/collection-plugin` の粒度まで内訳を出すので、知りたいことはそちらで分かる。

## 移植前に潰した懸念

mulmoclaude の `lint` は `--cache --cache-location node_modules/.cache/eslint/` 付きで、
しかも CI は `node_modules` をキャッシュする。**2回目以降にフォーマッタが受け取る結果が
痩せて、サマリーが「変更されたファイルだけ」になるのではないか**を疑った。

実測（`npx eslint scripts --cache --cache-location <tmp> --format json` を2回）:

| | files | messages |
| --- | --: | --: |
| 1回目（cold） | 32 | 10 |
| 2回目（warm・変更なし） | 32 | 10 |

一致したので `--cache` は結果を減らさない。サマリーは常に全件を反映する。

## 現状の実測（移植前に移植元のレンダラへ通した結果）

```text
## Lint findings — 43 (0 errors, 43 warnings)
```

上位ルール: `@typescript-eslint/no-unsafe-assignment` 19 / `sonarjs/function-return-type` 12
（この2つで全体の約7割）。上位ディレクトリ: `packages/core/src` 13 / `scripts/mulmoclaude` 7。

`AREAS` 未調整では 43 件中 20 件が `other` に落ちていた。差し替え後はこれが解消することを
テストと実行で確認する。

## 実装中に判明したこと

移植した `lint-summary.mjs` 自身が mulmoclaude の lint に引っかかった。`areaOf` の
`const top = relativePath.split("/")[0]` が `prefer-destructuring` の **error**
（移植元の設定では error ではない）。`const [top] = ...` に直した。抑制はしない。

これは「移植先の方が設定が厳しい」というだけの話だが、`yarn lint` を実際に走らせるまで
出てこなかった。ファイルをコピーして定数を差し替えただけで済む、とは限らない。

## 検証

- `test/scripts/test_lint_summary.ts` を node:test で書き、`yarn test` で通す。
  Windows 経路（`node:path` の `sep`）の分岐も含める — mulmoclaude は `lint_test_windows.yaml`
  で Windows でも lint するため、ここが壊れると Windows だけ全件 `other` に落ちる。
- `yarn lint:summary` を実際に流し、`other` が減って各 area に振り分くことを目視で確認する。
- `GITHUB_STEP_SUMMARY` を一時ファイルに向けて `yarn lint` を走らせ、**実際にファイルへ
  書かれること**を確認する（フォーマッタが呼ばれていることの ground truth。
  `lint:summary` はフォーマッタを経由しない別経路なので、それだけでは確認にならない）。
- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build`。
