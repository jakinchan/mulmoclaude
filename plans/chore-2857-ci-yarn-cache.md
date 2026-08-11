# CI: setup-node の yarn キャッシュ再検討（#2857）

## 背景 — Issue の前提を実測で検証した結果

Issue #2857 は「ほとんどのワークフローで `cache: yarn` が無く、e2e_live が最大の損失源」と書いている。
Actions API から実測したところ、**前提のうち 3 点が事実と異なっていた**。数字はすべて成功した実行
12 回以上の中央値（e2e-live は 13 ジョブ × 12 実行 = n=156）。

| ジョブ | `cache: yarn` | setup-node | yarn install | 合計 |
|---|---|---:|---:|---:|
| `dead-code-scan` (ubuntu 22) | ❌ | 1s | **76.5s** | 78.5s |
| `lint_test` (ubuntu 22) | ✅ | 25s | 31.5s | **55s** |
| `e2e-live` ×13 (ubuntu 24) | ✅ **既に有効** | 28s | 35s | 63s |
| `lint_test_windows` ×2 | ❌ | 6s | **235s** | 241s |
| `docker_sandbox_windows` | ❌ | 6.5s | **225s** | 232s |

### 訂正 1: `e2e_live_no_llm` には既に `cache: "yarn"` がある

作成時（2026-05-14, dd57f768c）から入っており、ログ上もヒットしている。

```
Cache hit for: node-cache-Linux-x64-yarn-ac16acdf...
Cache Size: ~2220 MB
Cache restored successfully          ← download 16s + tar 展開 23s
Cache hit occurred on the primary key, not saving cache.
```

Issue が挙げた「依存関係が各ジョブの 34〜58%」は**キャッシュが効いた状態の数字**であり、
`cache: yarn` を追加して回収できる余地ではない。`setup-node` の 28s は 2.2 GB のキャッシュ展開そのもの。

### 訂正 2: `codex_review` は `yarn install` を実行しない

`npm install -g @openai/codex` のみ。`cache: yarn` を足しても効果はなく、save/restore のオーバーヘッドだけ増える。

### 訂正 3: ubuntu での効果は 1 ジョブ約 23s（34〜58% ではない）

キャッシュ有無で唯一きれいに比較できるのが同じ ubuntu / node 22.x の 2 ジョブ:

- `dead-code-scan`（無し）: setup-node 1s + install 76.5s = **78.5s**
- `lint_test (22.x, ubuntu)`（有り）: setup-node 25s + install 31.5s = **55s**

コストが install からキャッシュ展開へ移動しているだけで、正味の短縮は約 23s。

## 本命は Windows — Issue が傍論扱いしていた部分

Windows の `yarn install` の内訳を 6 ジョブ分ログから抽出した:

| ジョブ | fetch | link | install 合計 | fetch 比率 |
|---|---:|---:|---:|---:|
| lint_test_windows (24.x) | 321s | 51s | 374s | **86%** |
| lint_test_windows (22.x) | 178s | 52s | 232s | 77% |
| lint_test_windows (24.x) | 180s | 48s | 230s | 78% |
| lint_test_windows (22.x) | 148s | 53s | 203s | 73% |
| lint_test_windows (24.x) | 177s | 55s | 234s | 76% |
| lint_test_windows (22.x) | 178s | 59s | 239s | 74% |

`[3/5] Fetching packages` が install の **73〜86%（148〜321s）** を占める。これはまさに
`cache: yarn`（= yarn のダウンロードフォルダのキャッシュ）が消す部分である。

現在 `lint_test_windows.yaml` はこう書いてスキップしている:

> Skip setup-node's built-in yarn cache on Windows — tar extraction on NTFS is
> slower than a fresh install. We use actions/cache for node_modules instead.

この判断の前提（新規インストールのほうが速い）は上の実測と矛盾する。新規インストールは
fetch だけで 148〜321s 使っている。

さらに、代わりに使っている `node_modules` キャッシュは**ヒットしているのに効果が測定できない**:

- キャッシュあり `lint_test_windows`: install 235s（+ 復元に 24〜31s）
- キャッシュなし `docker_sandbox_windows`: install 225s

yarn 1 は `node_modules` が既に在っても fetch フェーズを省略しないため、node_modules を
戻しても fetch の 148〜321s は消えない。309 MB × 2 エントリと毎回 24〜31s を払って
得ているものが無い。

## 制約: リポジトリの Actions キャッシュが上限超過

| 種別 | 容量 | 個数 |
|---|---:|---:|
| codeql-overlay-base-database | 2438 MB | 10 |
| node-cache-**Linux**-x64-yarn | 2220 MB | 1 |
| node-cache-**macOS**-arm64-yarn | 2219 MB | 1 |
| codex-cli-0.147.0-node22 | 936 MB | 8 |
| playwright-Linux | 364 MB | 1 |
| win-node-modules-{22,24}.x | 309 MB ×2 | 2 |
| puppeteer-{Windows,Linux,macOS} | 812 MB | 3 |
| **合計** | **10.07 GB / 10 GB 制限** | 174 |

既に上限を超えており LRU で追い出しが起きている。Windows に yarn キャッシュを足すと
`node-cache-Windows-x64-yarn` が約 2.2 GB 増える。したがって **効果が確認できた場合に限り**
入れ、同時に効果の無い `win-node-modules`（618 MB）を落として相殺する。

## やること

### 1. `dead-code-scan.yaml` に `cache: yarn` を足す（確実・容量増ゼロ）

setup-node のキャッシュキーは `node-cache-<OS>-<arch>-yarn-<lockfile ハッシュ>` で
**node バージョンを含まない**。dead-code-scan は ubuntu なので `lint_test` が既に作っている
`node-cache-Linux-x64-yarn-<hash>` エントリをそのまま共有する（キャッシュ容量の増加なし）。
期待値は 78.5s → 約 55s。

### 2. Windows の検証（実測してから採否を決める）

`lint_test_windows.yaml` の `pull_request` トリガーは path に
`.github/workflows/lint_test_windows.yaml` 自身を含むため、**この PR で Windows ジョブが
そのまま走る**。`docker_sandbox_windows` は `workflow_dispatch` があるのでブランチ指定で
手動実行できる。どちらも PR 上で実測できる。

ベースライン（いずれも n=12 の中央値）:

| ジョブ | setup-node | install | 合計 |
|---|---:|---:|---:|
| `lint_test_windows` (24.x) | 6s | 235.5s | 241.5s |
| `docker_sandbox_windows` | 6.5s | 225s | 232.5s |

条件を 1 つずつ動かす（CLAUDE.md「fix が依存する条件を変えてから検証済みと言う」）:

- **反復 1**: `cache: yarn` を足す。`node_modules` キャッシュは**残す**。
  1 回目の実行はキャッシュミス（保存コストのみ、短縮は出ない）、2 回目がヒット。
  ここで復元時間と install の fetch フェーズが潰れたかを見る。
- **反復 2**: 反復 1 が勝ったら `node_modules` キャッシュを削除して再測定。
  実測上これは 24〜31s 払って何も返していない（235s vs キャッシュ無し 225s）ので、
  削除で更に短縮し 618 MB のキャッシュ容量も戻るはず。

判定基準: 2 回目（ウォーム）の `setup-node + install` がベースラインを有意に下回ること。
下回らなければ両 Windows ワークフローの変更を revert し、既存コメントを実測値付きで
書き直すに留める（「NTFS 展開が遅い」という未検証の理由ではなく、実際に測った復元コストで）。

## 検証結果 — Windows は不採用（PR #2859 の実測）

**仮説は当たったが結論は外れた。** fetch が支配的という分析は正しく、キャッシュは実際に
install を潰した（225s → 64s、235s → 51〜79s）。しかし **NTFS 上の 2.2 GB 復元が 178〜247s** かかり、
削減分をそのまま食い潰す。

| ジョブ | ベースライン中央値 | ウォーム（キャッシュ有） | 差 |
|---|---:|---:|---:|
| `lint_test_windows` (24.x) | 274.0s (n=24) | setup 204 + nm 36 + install 79 = **319s** | **+45s 悪化** |
| `lint_test_windows` (22.x) | 274.0s (n=24) | setup 178 + nm 27 + install 51 = **256s** | −18s 改善 |
| `docker_sandbox_windows` | 232.5s (n=10) | setup 247 + install 64 = **311s** | **+78.5s 悪化** |

3 ジョブ中 2 つで悪化。付随コストも大きい:

- **保存に 457s**（コールド実行の `Post Use Node.js`）。`yarn.lock` が変わるたびに発生する
- **2212 MB を消費**し、追加した時点でキャッシュエントリが **174 → 78 に追い出された**。
  yarn キャッシュ 3 個だけで 6.65 GB / 9.93 GB（67%）を占める状態になった

つまり `lint_test_windows.yaml` の元のコメント（「NTFS の tar 展開は新規インストールより遅い」）は
**正しかった**。fetch 比率だけから結論を出したのが誤りで、復元コストを測る必要があった。
再提案されないよう、実測値をコメントに残す。

### 残った所見（この PR では変更しない）

`node_modules` キャッシュは依然として効果が測れない（`lint_test_windows` install 235.5s に対し、
キャッシュを一切持たない `docker_sandbox_windows` が 225s）。復元に 24〜36s と 618 MB を
払っている。削除の是非は yarn キャッシュとは独立した判断なので、別途検討する。

### やらないこと

- `codex_review.yaml`: `yarn install` しないため対象外（訂正 2）
- `yarn4_smoke`: Yarn 4 は別のキャッシュフォルダを使うので**新規エントリ**（推定 1 GB 超）が
  増える。得られるのは install 58s の一部で、上限超過の現状では割に合わない。容量に余裕が
  できてから再検討する
- `e2e_live_no_llm` / `mulmoclaude_smoke` / `pull_request`: 既に設定済み（訂正 1）

## 検証方法

Issue の指摘どおり Actions UI の目視ではなく API から step 単位で取る。
単発の before/after ではなく、**ベースラインは成功実行 12 回以上の中央値**を使う。

```sh
gh api "repos/receptron/mulmoclaude/actions/runs/<RUN_ID>/jobs?per_page=50" \
  --jq '.jobs[] | "\(.name)", (.steps[] | "  \(.name)  \(.started_at) \(.completed_at)")'
```
