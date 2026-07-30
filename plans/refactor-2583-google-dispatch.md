# google-plugin の dispatch を core/dispatch.ts に切り出す

Issue: #2583（spotify 37 / google 18 のうち **google 側**）· 発端: #2577 の CodeRabbit 指摘

## 何が問題か（行数ではない）

`packages/plugins/google-plugin/src/index.ts` の `dispatch` は 18 ケース・118 行だが、
本当のコストは**ルーティングをテストできないこと**。各ケースが依存をモジュールスコープの
import から直接呼ぶ:

```ts
case "tasksUncomplete": {
  const task = await uncompleteTask(await getGoogleAccessToken(), { taskId: args.taskId, taskListId: args.taskListId });
  return { ok: true, task };
}
```

`getGoogleAccessToken` / `uncompleteTask` が固定の import なので、「kind → 正しい関数 →
正しい引数」を検証するにはモジュールモックが要る。結果、現状のテストは args スキーマ
(`test_args_validation.ts`) と kind の網羅 (`test_kind_coverage.ts`) だけで、**対応表そのものは
誰も検証していない**。`sonarjs/cognitive-complexity` はフラットな switch を積み上げないので
自動ゲートも素通りする（plugin 配下には `complexity` / `max-lines-per-function` すら効いていない
— root の該当ブロックは `{src,test}/**` スコープ）。

## 形は html-plugin に合わせる

`packages/plugins/html-plugin/src/core/dispatch.ts` が先例。依存を context で注入し、
`never` の網羅性ガードを持つ。google も同じ形にする。

## 変更

### 新規 `src/core/dispatch.ts`

- `GoogleApi` — 注入される engine 関数の型。**シグネチャを手書きしない**:
  `Pick<typeof GoogleEngine, "getGoogleAccessToken" | …>`（`import type * as GoogleEngine from
  "@mulmoclaude/core/google"`）。core 側が引数を変えたらここが即座に型エラーになる = drift しない。
- `GoogleDispatchContext = { api: GoogleApi; log: Pick<PluginRuntime["log"], "info"> }`。
  `log` は `info` だけ使うので `Pick` で絞る（テストのスタブが小さくなる）。
- `executeGoogleDispatch(context, args)` — **1 ケース 1 行**の router。各ケースは名前付きハンドラ
  (`listEvents` / `createEvent` / `syncCalendar` …) を呼ぶだけにして、「kind → 呼ばれる関数」を
  目次として読めるようにする。`default` の `const exhaustive: never = args` は現状のまま維持。
- `runCalendarSync` / `restartFullSync` / `summarizeSync` も一緒に移し、engine 呼び出しを
  `context.api` 経由に付け替える。

router 本体は 18 ケース + default で 20 行を超えるが、これは issue の「やらないこと」に該当
（動機は行数ではない）。ハンドラ側は 1〜8 行に収まる。

### `src/index.ts`

薄くなる: `import * as googleApi from "@mulmoclaude/core/google"` を **namespace のまま**
context に渡す（`GoogleApi` は `Pick` なので構造的に満たす。23 関数を手で並べ直さない）。
`definePlugin` の中身は「args を parse して executeGoogleDispatch を呼ぶ」だけになる。

### 新規 `test/test_dispatch.ts`

呼び出しを記録するスタブ context（ネットワークもトークンも無し）で:

- **ルーティング**: 全 18 kind について「呼ばれた engine 関数」と「渡された引数」を検証。
  特に `maxResults` 未指定時の `DEFAULT_LIST_MAX_RESULTS` 適用、`args.start/end` →
  `startDateTime/endDateTime` の名前の付け替えなど、**今まで誰も見ていなかった対応**を固定する。
- **calendarSync のロジック**（回帰価値が最も高い）:
  - `fullResync: true` は **同期前に** token を捨てる（#2095 の意図。捨てる前に落ちても次回はクリーン）
  - 410 → `fullResyncRequired` で token を捨てて全同期をやり直す
  - `nextSyncToken` があれば保存する
  - `incremental` は「保存 token あり かつ 再同期不要」のときだけ true
  - `cancelled` の集計と `SYNC_SAMPLE_LIMIT` での truncate
- 網羅性: `GoogleArgs` の全 kind がテストに現れることを、スキーマ側の kind 一覧と突き合わせて確認
  （kind を足してテストを足し忘れたら落ちる）。

## やらないこと

- spotify（37 ケース）— issue の指示どおり **別 PR**
- 7 ケース以下のプラグイン（debug / edgar / markdown / recipe-book / bookmarks / email）
- 挙動の変更。返り値の形・ログ・エラー文言は現状のまま（純粋な構造変更）
