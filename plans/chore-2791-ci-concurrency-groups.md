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
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true
```

既存 5 本（`lint_test_windows` 等）は `${{ github.ref }}` を使っているが、これを今回の 6 本に
そのまま流用してはいけない。6 本とも `push: main` でも走るため、`github.ref` だと main への
連続 push で **前のコミットの main CI がキャンセルされる**（そのコミットの CI 結果が永久に
不明になる）。`github.event.pull_request.number` は push イベントでは空なので、
`github.run_id` にフォールバックさせて **push run を必ず単独グループにする**。

`cancel-in-progress: false` にして queue させる案は採らない。GitHub は pending run を
1 本しか保持せず、古い pending を捨てるため、結局 main の CI 結果が欠ける。

## 検証

- `actionlint` — pass（exit 0）
- 全 11 ワークフローに concurrency group があることをパースして確認
- `yarn format` / `yarn lint` は `.github/**` を対象にしていないので該当なし

## マージ後に見る指標

同じスクリプトで「新しい push に追い越されたまま完走した run」の割合を再計測する。
10% → ~0% になれば効いている。macOS の待ち p90 も併せて追う（ただしこちらは投入量が
主因なので、この PR だけで劇的には下がらない見込み）。

## 積み残し

**macOS マトリクスの縮小**。Windows は #1585 で PR CI から外して scheduled + main push に
移してある。macOS も同じ扱いにするか、Node 24 の 1 セルだけにすれば macOS ジョブが
半減〜1/4 になる。PR CI で macOS カバレッジをどこまで要るかの判断待ち。
