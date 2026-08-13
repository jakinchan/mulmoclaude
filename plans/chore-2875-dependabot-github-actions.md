# actions のメジャー更新を Dependabot で拾う (#2875)

## 背景

`.github/workflows/secret-scan.yml` を別リポジトリへ移植する際、actions の pin が
リポジトリ全体で **揃って1つ古い** ことに気づいた。個別のワークフローの問題ではない。

真因は **`.github/dependabot.yml` が存在しない** こと。この状態を正確に言うと:

- **security updates は動いている**。GitHub のリポジトリ設定側で有効なので
  `dependabot.yml` が無くても走る。`dependabot/npm_and_yarn/nanoid-3.3.18` (#2840) など、
  npm 側の脆弱性 bump は実際に PR が来ている。
- **version updates は設定されていない**。こちらは `dependabot.yml` が必須で、
  ファイルが無い＝どの ecosystem も対象外。`github-actions` の PR が過去に1本も無いのはこのため。

actions のメジャー更新は脆弱性ではないので security updates では拾われない。
結果、誰も手で上げなければ古いまま留まる。**バージョンを手で上げるだけでは数ヶ月後に同じ状態に戻る。**

## 現状（`origin/main` c69def758 で実測）

| action | 現在の pin | 最新 | 使用箇所 |
| --- | --- | --- | --- |
| `actions/checkout` | `@v6` | **`v7.0.1`** | 13 箇所 / 10 ファイル |
| `actions/setup-node` | `@v6` | **`v7.0.0`** | 9 箇所 / 7 ファイル |
| `actions/cache` | `@v5` | **`v6.1.0`** | 8 箇所 / 3 ファイル |
| `actions/upload-artifact` | `@v7` | `v7.0.1` | 5 箇所 / 3 ファイル（最新・対応不要） |

first-party 以外で使っているのは `github/codeql-action/upload-sarif` の1本のみで、
SHA pin + バージョンコメント付き。Dependabot は SHA pin もコメントごと更新できる。

## 破壊的変更の確認（リリースノートを実際に読んで確認）

- **`checkout` v7.0.0**: 実質的な挙動変更は
  [#2454](https://github.com/actions/checkout/pull/2454) の
  「`pull_request_target` / `workflow_run` での fork PR チェックアウトを禁止」のみ。
  **このリポジトリでは影響しない**:
  - `pull_request_target` を使うのは `pr_triage.yaml` だけで、そこには `uses: actions/checkout`
    が一切無い（27 行目のコメントどおり、意図的に攻撃者コードを取得しない設計）。
  - `workflow_run` を使うワークフローは存在しない。

  さらに、この破壊的変更は **v6.1.0 に backport 済み**
  ([#2500](https://github.com/actions/checkout/pull/2500))。`@v6` は動くメジャータグなので
  現時点で既に新挙動を引いている。つまり v7 へ上げても挙動は変わらない。
  残りは ESM 化と依存更新。

- **`setup-node` v7.0.0**: ESM 化、`cache-primary-key` / `cache-matched-key` の output 追加、
  `NODE_AUTH_TOKEN` のダミー export 削除、ドキュメント更新。入力の API は互換。

- **`cache` v6.0.0**: [#1760](https://github.com/actions/cache/pull/1760)
  「Update packages, migrate to ESM」のみ。v6.1.0 は read-only cache access の扱いを追加。

## この PR でやること

1. **`.github/dependabot.yml` を追加**（これが本題）。`package-ecosystem: github-actions`,
   `directory: "/"`, weekly。
2. その上で pin を最新メジャーへ: `checkout` → `@v7`、`setup-node` → `@v7`、`cache` → `@v6`。
   `upload-artifact` は既に `@v7` で最新なので触らない。

1 だけでも Dependabot が翌週 PR を出すが、2 を同じ PR でやっておくと
「Dependabot を入れた直後に3本の PR が飛んでくる」のを避けられ、初回の状態が静かになる。

## dependabot.yml の設計

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    commit-message:
      prefix: "chore(deps)"
    groups:
      github-actions:
        patterns: ["*"]
```

- **`groups` で1 PR にまとめる**: `.github/zizmor.yml` は「SHA pin は Dependabot の churn を
  招くので first-party actions はタグ pin にする」と明記している (#1423)。その方針と整合させる。
  タグ pin (`@v7`) なので Dependabot が PR を出すのは **メジャーが変わったときだけ**
  （`v7` は v7.x を自分で追従する）。年に数回で、まとめれば1本になる。
- **`commit-message.prefix: chore(deps)`**: 既存の npm security update の
  `chore(deps): bump nanoid from 3.3.16 to 3.3.18` と揃える。
- **`directory: "/"`**: `github-actions` ecosystem はリポジトリルート指定で
  `.github/workflows` 配下を走査する。

### npm の version updates は入れない（意図的な非対象）

このリポジトリは workspace が約 50 ある monorepo なので、npm の version updates を有効にすると
PR の量が現実的でない。#2875 が求めているのも actions 側。npm の脆弱性は今も
security updates が拾っているので、穴は空かない。必要になったら別途判断する。

## 検証

- `actionlint` + `zizmor`（`workflow-lint.yaml` が `.github/**` の変更で走る）で
  ワークフロー側の構文と security を確認。
- `dependabot.yml` 自体は上記2つの対象外なので、YAML として妥当なこと + GitHub 公式スキーマの
  必須キー（`version: 2`, `updates[].package-ecosystem`, `.directory`, `.schedule.interval`）を確認。
  マージ後は Dependabot の「Last checked」がリポジトリ設定画面に出るので、そこで実地確認する。
- pin 更新は CI 全体（`pull_request.yaml` / `lint_test_windows.yaml` / smoke / e2e）が
  そのまま新しい action で走ることが ground truth。
