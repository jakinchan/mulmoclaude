# ブローカーのコールドブート時間を Windows Docker ワークフローで実測する

Issue: #2233（#2201 のフォローアップ①）· 後続: #2235（起動時間そのものを削る）

## なぜ計測が先か

#2201 の「約15秒」は**スモークテスト全体の所要時間（15872ms）からの推定**であって、ブローカー単体の
起動実測ではない（#2233 本文に明記）。#2234（`alwaysLoad` + `MCP_CONNECT_TIMEOUT_MS` 引き上げ）は
フィールドで「頻度は大きく下がったが根本解消せず」と判定され（#2234 コメント, 2026-07-27）、
#2233 / #2235 が再オープンされた。

`MCP_CONNECT_TIMEOUT_MS` は現状 `ONE_MINUTE_MS` で、コード側コメントに「#2233 が実測したら
その値＋マージンに詰められる」と書かれたまま。#2235 の方式選定（事前ビルド vs 遅延 import）も
実測待ち。

## 測る対象を間違えると判断を誤る

手元（macOS ネイティブ・warm cache。**Windows bind mount ではないので下限値**）で
`test/sandbox-repro/mcp-handshake.jsonl` を実物のブローカーに流して計った:

| 測り方 | 値 |
|---|---|
| プロセス全体の所要時間 | 約 5.7 秒 |
| **`initialize` に応答するまで** | **約 1.1 秒** |
| （内訳）tsx 自体の起動 | 約 0.55 秒 |
| （内訳）`mcp-tools` の import | 約 0.34 秒 |

同じ環境で **5.7秒 vs 1.1秒**、5 倍ずれる。CLI のレースに効くのは
「ブローカーが spawn されてから `initialize` に応答するまで」であって、プロセス全体の時間ではない
（#2201 の 15872ms がまさに全体時間からの推定だった）。

## 変更

`.github/workflows/docker_sandbox_windows.yaml` の既存 end-to-end ステップ
（`#2052 — end-to-end: real mcp-server.ts answers initialize + tools/list`）に計時を足す。
新しいコンテナハーネスは作らない — コンテナ spec は既存どおり `print-mcp-container-spec.ts`
から導出する（derive; never duplicate）。

### コンテナ内で測る

`npm install -g tsx` は**計測窓の外**に置く。本番の sandbox イメージは tsx を同梱していて
毎ターン払わないコストなので、含めると数字が膨らむ。

`date +%s%3N`（GNU date, node:22-slim は Debian）で、ブローカー spawn 直前を起点に、
応答行が出た時刻を拾う:

- `initialize` 応答まで = **レースを決める数字**。`MCP_CONNECT_TIMEOUT_MS` と直接比較する
- `tools/list` 応答まで = handshake 完了（issue 本文が挙げている数字）

### cold / warm の 2 回まわす

同じコンテナ内で handshake を 2 回実行する。1 回目は bind mount 越しの初回読み、2 回目は
ページキャッシュが温まった状態。本番も**毎ターン新コンテナだがホスト側のページキャッシュは
残る**ので、2 回目は「2 ターン目以降」のモデルになる。

#2201 は間欠性を「マシン負荷・FS キャッシュ等による起動時間の揺らぎ」で説明しているので、
この 2 つの差自体が #2235 の判断材料になる（差が大きい＝ FS 起因が支配的＝事前ビルドが効く、
差が小さい＝ import グラフ自体が重い＝遅延 import が効く）。

### 出力

ログと job summary の両方へ。docker run 全体の wall time も併記するが、
**`npm install -g tsx` を含む**ことを明示する（本番は払わないコスト）。

**ゲートしない**。共有 runner の負荷ノイズで閾値判定は flaky になるし、issue の完了条件は
「job summary から読める」こと。同ファイル内の #2052 診断ステップと同じ
「They REPORT; they do not gate the job」方針に揃える。

## 検証

このワークフローは Windows + WSL2 + Docker が要るのでローカルでは走らない。分けて確かめる:

1. **bash の計時ロジック** — スタブのブローカー（`serverInfo` / `handlePermission` を含む行を
   遅延付きで吐く）に対してローカルで走らせ、`TIMING` 行が出て値が仕込んだ遅延と一致することを見る
2. **PowerShell の parse** — 同じ `TIMING` 行を食わせて job summary の表が組めることを見る
3. **実物** — ブランチを push して `workflow_dispatch` で実行し、job summary に実測値が出ることを見る
   （完了条件そのもの）

## 実測結果（#2235 への引き継ぎ）

`workflow_dispatch` を 3 回。単位は ms、`initialize` に応答するまで。

| run | cold | warm |
|---|---|---|
| [30597793909](https://github.com/receptron/mulmoclaude/actions/runs/30597793909) | 21,224 | 20,828 |
| [30598789585](https://github.com/receptron/mulmoclaude/actions/runs/30598789585) | 22,816 | 23,913 |
| [30600291086](https://github.com/receptron/mulmoclaude/actions/runs/30600291086) | 20,232 | 21,065 |

### 1. 約 20〜24 秒。CLI 既定の接続待ち（約 5 秒）の 4〜5 倍

#2201 の推定「約15秒」より**さらに遅い**。#2234 が `MCP_CONNECT_TIMEOUT_MS` を 1 分に
上げたのは正しく、それでも間欠再発が続いていることと整合する。

### 2. cold と warm に有意差なし

差は run 1 で warm が 396ms 速く、run 2/3 では warm が 833〜1,097ms **遅い**。
run 間のばらつき（約 3 秒）の方が cold/warm 差より大きく、**ページキャッシュは効いていない**。

これが #2235 にとって最重要。#2201 は間欠性を「FS キャッシュ等による揺らぎ」で説明していたが、
20 秒はキャッシュミスではなく**毎回必ず払う仕事**（tsx が import グラフを変換する作業そのもの）。
「温まれば速くなる」類の対策には意味がなく、**ビルド済み JS（方式1）か import グラフを減らす
（方式2）のどちらかが必須**という結論になる。

### 3. `initialize` と `tools/list` の差は 10〜20 ms

handshake 自体はタダ。コストは 100% 起動側で、ツール定義の生成を削っても効かない。

### 4. プリセットプラグインのロードが計測窓の内側

ログに `INFO [plugins/preset] loaded requested=5 succeeded=5` が `initialize` 応答前に出る。
方式2（遅延 import）の具体的な標的。

### 副次的に見つかったもの（本 issue の範囲外）

ブローカーがコンテナ内で handshake ごとに 2 回吐いている:

```
[logger] file sink error: Error: ENOENT: no such file or directory, mkdir 'server/system/logs'
    at async ensureDir (/app/server/system/logger/rotation.ts:14:3)
```

相対パスでログディレクトリを作ろうとして失敗している。害はなさそうだが起動経路のノイズ。

## やらないこと

- 閾値でのゲート
- `MCP_CONNECT_TIMEOUT_MS` の変更 — 実測が出てからの別作業
- #2235 の実装（事前ビルド / 遅延 import）
