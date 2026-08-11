# Windows CI の collection root テスト失敗を直す（#2864）

## 現状

`lint_test_windows` が 4 コミット連続で赤（`3abf85a90` / `2bc38f5d7` / `946245f2f` / `173fba0d6`）。
ubuntu / macOS は緑なので Windows 限定。`yarn run test:coverage` の 5 件が失敗している。

## 原因

本番コードのバグではなく、テスト fixture がプラットフォーム依存。

`canonicalRoot` は `path.resolve` そのもの。POSIX 絶対パスを直書きした fixture は Windows で
別の文字列に解決される:

```
"/work/proj"   win32 = "\work\proj"   posix = "/work/proj"
"/work/proj/"  win32 = "\work\proj"   posix = "/work/proj"
```

（実機の Windows ではカレントドライブが付いて `C:\work\proj`。どちらにせよ `/work/proj` ではない。）

`test_collectionKey.ts` が同じ POSIX パスで緑なのは、`isCanonicalRootShape` が isomorphic ゆえに
`node:path` を使えず **POSIX 形と Windows ドライブ形の両方を正準と認める**ため。canonicalise を
するのは `canonicalRoot` の側だけ。本番の Windows ではルートが常に Windows 形なので両者は一致し、
食い違うのは POSIX 直書き fixture だけ。

## やること

### 1. テスト用ヘルパー `packages/core/test/helpers/testRoot.ts` を足す

```ts
export const testRoot = (...segments: string[]): string => path.resolve("/", ...segments);
```

POSIX で `/work/proj`、Windows で `C:\work\proj`。つまり「動作中のプラットフォームで
`canonicalRoot` が生成する形」の notional root。WHY をここに 1 回だけ書く。

### 2. 失敗している 2 ファイルの fixture を差し替える

- `test_completionIdShared.ts` — 期待する id 文字列も同じ root から組み立てる。
  末尾セパレータのケースは `path.sep` を使う
- `test_changeKey.ts` — `HOST_ROOT` とプロジェクトルートを `testRoot()` 由来にする

構造（`collection-completion:@<root>\0<slug>:<itemId>`）と正準化（末尾セパレータの吸収）を
pin する目的は維持する。変えるのはルート文字列がプラットフォーム依存でない、という点だけ。

## 検証

- macOS でテストが緑のままであること（既存の pin を壊していないこと）
- **`path.win32` で Windows の解決を再現し、修正後の期待値が win32 でも成立することを確認**
- **`lint_test_windows` を `workflow_dispatch` でこのブランチに対して実行し、実機 Windows で 5 件が
  緑になることを確認**（このワークフローの `pull_request` トリガーは path 限定で、
  `packages/core/test/**` では起動しないため、dispatch が唯一の実機確認手段）

推論で「直ったはず」と言わない。実機 Windows の結果を根拠にする。

## やらないこと

- `canonicalRoot` / `isCanonicalRootShape` の仕様変更。本番の挙動は正しい
- `lint_test_windows` のトリガー変更（毎 PR で Windows を回すのはコストが大きい。
  ただし「マージ後にしか気付けない」構造そのものは #2864 に観測として残す）
