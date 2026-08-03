# fix #2805 — e2e シャードが install-deps 完了後に終了しない件

## 原因(実測)

`npx playwright install-deps` は**毎回20数秒で正常完了している**。遅いのではなく、
**完了後にステップが返らない**まま `timeout-minutes: 15` を使い切って cancel される。

| PR | ステップ開始 | 作業完了(needrestart 最終行) | 作業時間 |
|---|---|---|---|
| #2787 | 06:57:44.98 | 06:58:07.83 | 23秒 |
| #2797 | 10:22:43.88 | 10:23:11.32 | 27秒 |
| #2801 | 20:47:27.95 | 20:47:50.80 | 23秒 |

同一 run の成功シャードは作業完了の **0.9秒後**に次のステップへ進んでいる。
コマンド・出力・完了までの時間は同一で、違いは「完了後に返るか」だけ。

playwright の実装(`playwright-core` の `coreBundle.js`)を読むと筋が通る:

```js
const child = childProcess2.spawn(command, args, { stdio: "inherit" });
await new Promise((resolve, reject) => {
  child.on("exit", (code) => ...);   // close ではなく exit
});
```

`stdio: "inherit"` なので sudo→sh→apt はランナーのパイプ fd を**直接**継承し、
playwright 自身は `exit` で待つので即座に終了する。よって「playwright が終わらない」線は消え、
**apt 中に生まれた常駐プロセスがランナーのパイプを握ったまま生き残る**筋だけが残る。
ランナーはステップの stdout/stderr が EOF になるまで待つので、それでステップが終わらない。

ただし**犯人プロセスは特定していない**。

## 方針: 緩和ではなく、apt ステップを無くす

当初はリダイレクト + ステップ timeout + needrestart 抑止という**緩和**を実装した。
しかし「マージする意味があるのか」という問いに対して弱い:

- ステップ timeout 単体では**再実行は減らない**。早く赤くなるだけ。
- リダイレクトは筋は通るが、犯人プロセス未特定のまま「効くはず」で運用することになる。

**公式 Playwright イメージには browser と OS ライブラリが同梱されている**ので、
`container:` に指定すれば **apt ステップそのものが存在しなくなる**。
壊れるステップが無くなるので、原因の特定を必要としない。

あわせて、このジョブが抱えていた 392MB のブラウザキャッシュ(#1725 対策)も不要になる。

## 変更するもの — 対象の CI だけ

`.github/workflows/pull_request.yaml` の **`e2e` ジョブのみ**。
`e2e_live_no_llm.yaml` は今回の障害が観測されていないので触らない。

削除するステップ(すべてイメージが肩代わりする):

- `Resolve Playwright version`
- `Cache Playwright browsers`
- `Install Playwright browsers`
- `Install Playwright OS dependencies` ← 実際に wedge していたステップ

追加するステップ: イメージと `@playwright/test` の**バージョン不一致を検出するガード**。
片方だけ bump されると 268 テストが1件ずつ「実行ファイルが無い」で落ちるので、その前に落とす。

## 気をつけた点

- **`--user 1001`** — Playwright が GitHub Actions 向けに文書化している設定。
  ランナーの uid と一致するのでマウントされた workspace が書き込み可能なままになり、
  かつ Chromium が root で起動を拒否する(`--no-sandbox` 必須)問題も避けられる。
  `e2e/playwright.config.ts` は `chromiumSandbox` を落としていないので、root のままだと動かない。
- **`test:e2e` の `ensure:playwright-browsers`** は `playwright install chromium webkit`
  (`--with-deps` なし = apt なし)。イメージ内では既存バイナリを見つけて no-op になる。
- **ジョブの `timeout-minutes: 15` は変えない**。原因は遅さではないので伸ばすのは誤った対処。

## 検証

- `actionlint`(リポジトリの workflow-lint と同じもの)を全ワークフローで通過
- ガードスクリプトをワークフローから取り出して**実行**し、
  正常系(browser あり → exit 0)と**異常系**(`PLAYWRIGHT_BROWSERS_PATH` を空ディレクトリに向ける
  → exit 1 + 設定すべきタグ名を表示)の両方を確認
- `@playwright/test` / `playwright-core` が 1.62.1 で、イメージタグ `v1.62.1-noble` と一致

**ローカルで検証できないこと**: コンテナジョブ自体の挙動(checkout / setup-node / yarn install /
キャッシュが `--user 1001` のコンテナ内で動くか)。これは**この PR 自身の e2e 2シャードが緑になること**
でしか確認できない。

## やらないこと

- `e2e_live_no_llm.yaml` — 今回の障害が出ていないので対象外。
  同じ形で詰まるなら別途同じ手を当てる。
- ジョブ timeout の延長、リトライの追加。
