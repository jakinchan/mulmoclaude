# CI の待ち時間を減らす: 追い越された PR run をキャンセルする (#2791)

## 背景（実測）

「CI が遅くなった気がする」という体感を GitHub Actions API で確認した（2026-07-20〜08-03、
Node.js CI の run 1000 件 + main push サンプルのジョブ 360 件）。

- **ジョブ実行時間は横ばい**。main push サンプルの中央値で lint_test (ubuntu) が 11.5 → 13 分と
  微増した以外、2 週間で有意な変化なし。e2e は 8〜9 分で一定。
- **遅延は runner の待ち時間**に集中し、macOS が突出している。

  | runner | 待ち中央値 | p90 | 最大 |
  |---|---|---|---|
  | macos-latest | 0.3 分 | 89.1 分 | 158.6 分 |
  | ubuntu-latest | 0.1 分 | 10.3 分 | 20.3 分 |

- 待ちが跳ねた日は run 投入量が跳ねた日と一致する。全ワークフロー合計で
  7/30 267 → 8/01 629 → 8/02 950 run/日（Node.js CI 単体で 30 → 108/日）。
  1 run につき macOS ジョブが 2 本（22.x / 24.x）走るので、8/02 は macOS だけで 216 ジョブ。

## この PR でやること

投入量そのものを減らす手（macOS マトリクス縮小）は別途判断が要るので、
先に **無条件に効く分だけ** を入れる: 追い越された PR run を最後まで走らせない。

計測: 7/30〜8/03 の Node.js CI の PR run 166 件のうち **17 件 (10%) が、新しい push が
始まった後も完走していた**。捨てられた runner 時間は 192 分ぶん（各 run 6 ジョブなので
実際の runner 消費はその数倍）。

`concurrency` group が無いワークフローは 6 本あった:

- `pull_request.yaml` (Node.js CI) — 6 ジョブ / うち macOS 2
- `secret-scan.yml`
- `duplication-scan.yaml`
- `dead-code-scan.yaml`
- `mulmoclaude_smoke.yaml`
- `workflow-lint.yaml`

## group の切り方

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}-${{ github.run_attempt }}
  cancel-in-progress: ${{ github.run_attempt == '1' }}
```

既存 5 本（`lint_test_windows` 等）は `${{ github.ref }}` を使っているが、これを今回の 6 本に
そのまま流用してはいけない。6 本とも `push: main` でも走るため、`github.ref` だと main への
連続 push で **前のコミットの main CI がキャンセルされる**（そのコミットの CI 結果が永久に
不明になる）。`github.event.pull_request.number` は push イベントでは空なので、
`github.run_id` にフォールバックさせて **push run を必ず単独グループにする**。

`cancel-in-progress: false` にして queue させる案は採らない。GitHub は pending run を
1 本しか保持せず、古い pending を捨てるため、結局 main の CI 結果が欠ける。

`run_attempt` を group に混ぜているのは、**古い run を手動 re-run したときに、PR 番号で
束ねているせいで「最新コミットの in-flight run」の方がキャンセルされる**のを防ぐため。
flaky テストの re-run が日常的に起きるので実害がある。re-run（attempt >= 2）は別グループに
落ちたうえで `cancel-in-progress` も false になり、誰もキャンセルしない・されない。

なお「re-run が同じ run の前の attempt をキャンセルする」ことは起きない。GitHub は完了した
run しか re-run できないので、attempt 1 が in-progress のまま attempt 2 は始まらない。

## 検証

- `actionlint` — pass（exit 0）
- 全 11 ワークフローに concurrency group があることをパースして確認
- `yarn format` / `yarn lint` は `.github/**` を対象にしていないので該当なし

## この PR 上での実効性確認

マージを待たずにこの PR 自体で確かめられる。`pull_request` イベントではワークフロー定義が
PR ブランチ側から読まれるので、追加した concurrency group はこの PR の run に既に効いている。

手順: 1 回目の push の run が走っている最中に 2 回目の push を投げ、1 回目の run が
`cancelled` に落ちることを GitHub 側の run status で確認する（自分の出力どうしを突き合わせても
証拠にならないので、ground truth は GitHub の run status を見る）。

`pull_request` の paths / paths-ignore フィルタは PR の全差分に対して評価されるため、
2 回目の commit が plans/ だけを触っていても、PR 差分に `.github/workflows/**` が含まれている
以上 6 本とも再トリガされる。

### 実測結果

1 回目の push の run を 2 回目の push が追い越した結果、Node.js CI `30797783871` が
`cancelled` に落ちた。7 ジョブが約 6.2 分経過時点で一斉停止。8/03 のジョブ別中央値を
完走時間として差を取ると **約 32.6 runner 分（うち macOS 15.6 分）** が浮いた計算になる。

他の 5 本は 1 ジョブで軽く、追い越される前に完走していたのでキャンセル対象が無かった。

`cancel-in-progress` を `${{ github.run_attempt == '1' }}` の式に変えた後も、同じ手順で
キャンセルが効くことを再確認する（式が評価に失敗すると PR 全体が no-op になるため、
actionlint が通ったことは根拠にならない）。

## マージ後に見る指標

同じスクリプトで「新しい push に追い越されたまま完走した run」の割合を再計測する。
10% → ~0% になれば効いている。macOS の待ち p90 も併せて追う（ただしこちらは投入量が
主因なので、この PR だけで劇的には下がらない見込み）。

## 積み残し

**macOS マトリクスの縮小**。Windows は #1585 で PR CI から外して scheduled + main push に
移してある。macOS も同じ扱いにするか、Node 24 の 1 セルだけにすれば macOS ジョブが
半減〜1/4 になる。PR CI で macOS カバレッジをどこまで要るかの判断待ち。
