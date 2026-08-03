# fix #2784 — `test_resolvePath.ts` がフルスイート実行時にまれに失敗する

## 結論: 機構は特定できた

macOS は **新規作成された実行ファイルを初回 exec するときにコード評価を行い、その評価はシステム全体で直列化する**。
並列フルスイート実行のように「新しい実行ファイルを書いては exec する」プロセスが同時に多数走ると、
この評価が詰まって **1 回の exec が 10 秒以上ブロックする**。

`test_resolvePath.ts` は毎回 `mkdtemp` した HOME に fake shell を**新規作成して exec する**ので、
そのブロックがそのまま login-shell hop の所要時間になる。
`resolve-path.sh` 自身のウォッチドッグ `MC_HOP_TIMEOUT_S=10` を超えると hop は kill され、
`mc_login_path` は空を返し、`mc_resolve_path` は**黙って `mc_scan_tool_dirs` にフォールバックする**。
その結果テストは「hop が返した PATH」ではなく**このマシンの実 PATH**と比較することになり、落ちる。

issue が「機構未特定」で止まった理由は 2 つあり、どちらもここで解消する:

- 10 秒を `SHELL_TIMEOUT_MS`(30 秒)と比べて別物と判断していたが、
  実際は **`resolve-path.sh` 内の `MC_HOP_TIMEOUT_S=10`** だった。観測値 10093ms / 10063ms がそのまま裏付け。
- 記録された `actual` の文字列 `/optusr/homebrewin:...` は実際の値ではなく、
  **`node:assert` の文字単位 diff から ANSI を落としたもの**。実際の値は
  `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`(= スキャンのフォールバック結果)。

## 再現(このマシンで実測)

| 条件 | フォールバック | 所要時間 |
|---|---|---|
| 負荷なし | 0 / 15 | max 356ms |
| CPU 負荷 60 プロセス | 0 / 15 | max 373ms |
| TMPDIR への FS 負荷 24 プロセス | 0 / 20 | max 847ms |
| **新規実行ファイルを書いて exec する負荷 30 プロセス** | **20 / 20** | **~10035–10107ms** |
| 対照: 同じ負荷量だが既知バイナリを exec | 0 / 20 | max 574ms |

CPU 負荷でも FS 負荷でも再現せず、**「新規実行ファイルの exec」でのみ**再現する。
ウォッチドッグを 300 秒に上げて真の所要時間を測ると **6.9s – 18.5s** に分布しており、
固定 10 秒はこの分布のちょうど内側 — だから「毎回落ちる」でも「絶対落ちない」でもなく flaky になる。

`node:assert` に上記 2 つの文字列を渡すと、issue に貼られた壊れた文字列が
**完全一致で再現する**(ANSI 除去後)。

## 修正方針

### 1. fake shell を計測前に一度 exec して暖める(根本原因の除去)

同じ負荷下で **0 / 15**(max 115ms)。cold で 20/20 落ちる負荷で 1 度も落ちない。
評価コストを計測区間の外で払うだけなので、テストが検証している挙動には触れない。

暖機は `__warmup__` という専用引数で行う。実行時の引数と区別できるので、
「暖機だけ通って本番の hop が走らなかった」場合にテストが誤って緑になることはない
(フラグ記録用の fake shell は暖機時に `__warmup__` を書き、本番実行で上書きされる)。

対象は fake shell を exec する 4 テスト。
`gives up on a shell that hangs` の `sleep 30` shell は暖機しない
(ウォッチドッグが 2 秒で kill するため cold でも影響を受けず、暖機すると 30 秒かかるだけ)。

### 2. hop の答えを継承 PATH と区別できる値にする(診断可能性)

現状 fake shell は `$PATH`(= `GUI_PATH`)をそのまま返すので、期待値が `GUI_PATH:GUI_PATH` になる。これは:

- **アサーションが弱い** — `mc_resolve_path` が `echo "$PATH:$PATH"` に退化しても通ってしまう。
  「hop の PATH が前置される」ことを検証できていない。
- **失敗時の diff が読めない** — 自己相似な文字列同士の文字単位 diff が、issue に貼られたあの文字列になる。

fake shell 側で `PATH` を専用のマーカー値に差し替え、期待値を `<marker>:GUI_PATH` にする。
フォールバックが起きた場合は「マーカーが無い」と一目で分かる。

## 変更しないもの

- `server/utils/launcher/macos/resolve-path.sh` — プロダクト挙動としては
  「重すぎるマシンでは hop を諦めてスキャンに落ちる」で正しい。テスト側の問題。

## 検証

- 単独実行で全 7 件 green
- 上の「新規実行ファイル exec 負荷 30 プロセス」下で `test_resolvePath.ts` を繰り返し実行し、
  修正前は落ち、修正後は落ちないことを確認する(fix を revert すると赤に戻ることまで見る)
- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build`

## 別件として報告するもの(この PR では直さない)

このマシンの `$TMPDIR` に **106 万件**のエントリが溜まっている。テストが `mkdtemp` した一時ディレクトリを
消していないため。上位: `mulmo-runtime-load*` 47,642 / `google-secret-test*` 36,988 /
`mulmo-viewtoken-te*` 34,992 / `google-token-test-*` 17,398 …
今回の flake の原因ではない(FS 負荷では再現しない、`mktemp` は 0.00s)が、別途 issue にする価値がある。
