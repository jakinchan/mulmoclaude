# fix(calendar): カレンダー同期にホスト間の重複実行ガードを入れる (#2678)

## Request

`googleCalendarSyncTaskDef()` は「複数ホストが登録する前提」で core の factory として提供されて
いるのに、カレンダー同期にはホスト間の重複実行を防ぐ仕組みが無い。feeds には `lastFetchedAt` に
よる soft-dedup があるのに calendar には無い、という非対称。

現在問題が表面化していないのは協調が効いているからではなく、実際に登録しているホストが
MulmoClaude 1つだけだから。MulmoTerminal が同じ1行を足した瞬間に露出する。
`@mulmoclaude/core@1.11.0` の `autoPush` (#2620) で定期タスクが Google への**書き込み**まで
行うようになったため、影響範囲が広がっている。

## 前提の確認 — issue の指摘はすべて裏が取れた

| 指摘 | 確認したもの |
|---|---|
| リンク判定はホスト単位に見えて実体は共有 | `paths.ts:10` の `googleConfigDir()` は `~/.config/mulmo` — アプリ名もワークスペースも含まない。同一マシンの2ホストは両方 `true` を返す |
| 時刻ベースの due 判定が無い | `syncDueCalendarCollections` (`collectionSync.ts:499`) は宣言している group を毎回すべて回す。永続化している状態は sync token だけ |
| ロックはプロセス内限定 | `calendarLocks` (`calendarLock.ts:32`)、`.sync-state.json` / `.push-state.json` の write queue (`calendarSyncStore.ts:42` / `calendarPushState.ts:58`) はいずれもモジュール状態 |
| 設計ノートに multi-host の記述が無い | `plans/done/feat-2095-*.md` を確認。見落としではなく、実際に検討されていない |

### さらに悪い条件が1つ見つかった — 2ホストは「同じ分」に発火する

`task-manager.ts:95` の `isDue` は interval タスクを**壁時計境界**に揃える:

```ts
const rounded = Math.floor(msSinceMidnight / tickMs) * tickMs;
return rounded % schedule.intervalMs === 0;
```

プロセス起動時刻からの経過ではなく UTC 0時からの経過で判定するので、hourly タスクは
**どのホストでも毎時 HH:00 台に発火する**。「ホストごとに位相がずれているから実際にはぶつかりにくい」
という慰めは無い。ずれるのは各ホストの tick ループの位相（最大60秒）だけ。

これは設計判断に直接効く: **終了時にスタンプする方式では重複を防げない**（両ホストがほぼ同時に
開始し、両方とも走り切ってからスタンプする）。開始時にスタンプする必要がある。

## 前提の限界 — これは「同じワークスペースを見ているホスト」にしか効かない

feeds の soft-dedup が効くのは `lastFetchedAt` が**ワークスペース状態**で、両ホストが同じ
workspace root を指しているから。calendar の `lastSyncedAt` もその性質をそのまま継承する。
MulmoTerminal が別ワークスペースを持つ構成なら、どちらの仕組みも効かない（共有されているのは
Google カレンダー本体と `~/.config/mulmo` だけになる）。**この PR は feeds と同じ前提の上に立つ。**

## 決めたこと

### 1. `lastSyncedAt` をカレンダー単位でワークスペースに持つ

既存の `<workspace>/data/calendar/.sync-state.json` に `tokens` と並べて置く:

```json
{ "tokens": { "primary": "CAES..." }, "lastSyncedAt": { "primary": "2026-08-01T09:00:03.412Z" } }
```

同じファイルにする理由 — 原子的書き込みと read-modify-write の直列化が既にあり、寿命も同じ
（どちらも「このワークスペースが何を持っているか」の主張なので、ワークスペースと一緒にリセット
されなければならない）。`tokens` しか無い旧ファイルは空マップとして読める。

sync token とは別の関心事にする（issue の指摘どおり）。token は「どこまで取り込んだか」であって
「最後にいつ走ったか」ではない。

### 2. 実行の**開始時**にスタンプし、失敗したら取り消す

feeds は成功時にスタンプするが、feeds の refresh は読むだけ。`autoPush` 以降のカレンダー同期は
Google に**書き込み**、`.push-state.json` を書き換える。終了時スタンプでは実行時間まるごと
（初回フルウォークなら数分）が他ホストの開始に対して開いたままになる — それが baseline の
lost update が起きる窓そのもの。開始時に押せば、窓は read → write の隙間だけになる。

失敗時（throw、または結果に retryable な `errors` がある）はマーカーを消す。掴んだまま失敗した
ホストが1時間カレンダーを塞ぐのを防ぐ = 失敗時の挙動は現状と変わらない。

マーカーの書き込み自体が失敗しても同期は止めない（重複防止は最適化であって同期の前提条件では
ない）。warn を出して現状の挙動に落ちる。

### 3. ゲートはスケジュール経路だけに掛ける

- `syncDueCalendarCollections` — due な group だけ回す。関数名がやっと名前どおりになる
- 手動 Refresh (`syncCalendarForCollection`) と作成トリガ (`syncNewCalendarCollections`) は
  無条件に走る。ユーザーのクリックが黙って skip されるのは許容できない
- ただし**どの経路もスタンプはする**ので、手動 Refresh の直後のスケジュール実行は skip される

feeds と同じ形（`refreshOne` は常にスタンプ、`refreshDue` だけが `isFeedDue` で絞る）。

### 4. due window は「タスクの実際の interval − ジッタ猶予」

```ts
calendarSyncDueWindowMs(intervalMs) = intervalMs - min(5min, intervalMs / 2)
```

- 単独ホスト hourly: 経過 ≈ 60分 ≥ 55分 → 毎 tick 走る（猶予が無いと、自分のマーカーを
  「まだ due でない」と読んで**隔時間実行**になる）
- 2ホスト hourly: 先に押した方が走り、もう片方は skip → ワークスペースあたり毎時1回
- interval を短く override した場合も、猶予が窓を食い潰さない（`intervalMs / 2` で床を張る）

**interval はタスク定義から実行時に読む。** ホストは `googleCalendarSyncTaskDef()` が返した後で
`task.schedule` を overrides.json で書き換える（`server/index.ts:1223`）ので、factory 実行時の
値で窓を固定すると「15分に縮めたのに実質1時間」という無言のバグになる。

不正な値の扱い: マーカーが未設定/パース不能なら due。ホストの時計が進んでいて窓1つ分より未来の
マーカーが書かれていた場合も due（時計ずれが続く限り永久に止まるのを避ける）。

### 5. 付随して直すもの

- `releaseOrphanedCalendarToken` は token と shadow に加えてマーカーも落とす（残骸を残さない）
- ログ文言 `no Google account linked on this host` から `on this host` を落とす —
  リンクはマシン全体で共有されており、ホスト単位であるかのような文言が今回の誤解の元

## やらないこと — `.push-state.json` のクロスプロセス lost update

soft-dedup はこれを**狭めるが塞がない**。`withCalendarLock` はプロセス内なので、ホスト A の
Refresh / Push ボタンがホスト B のスケジュール実行に重なる経路は残る。

塞ぐには `withCalendarLock` の内側にクロスプロセスのファイルロックを敷くことになるが、それは
- 手動経路に "busy" という新しい結果を作り、HTTP ルート / UI / 8ロケールに通す
- クラッシュしたホルダーのための stale lock 処理を持つ

という、この issue のタイトルとは別物の変更になる。**#2679 に切り出した。**

## 実装

| ファイル | 変更 |
|---|---|
| `packages/core/src/google/calendarSyncStore.ts` | 状態を2マップ化。`load/save/clearCalendarLastSyncedAt` を追加。壊れたファイルに耐える正規化 |
| `packages/core/src/google/calendarSyncDue.ts` | 新規。純関数 `calendarSyncDueWindowMs` / `isCalendarSyncDue` |
| `packages/core/src/google/collectionSync.ts` | `syncCalendarGroup` に claim/release、`syncDueCalendarCollections` にゲート、`dueCalendarGroups`、task def の interval 引き回し、ログ文言 |
| `packages/core/src/google/index.ts` | 追加分の re-export |
| `test/services/google/test_calendarSyncStore.ts` | マーカーの round-trip / 隔離 / token との共存 / 旧ファイル互換 |
| `test/services/google/test_calendarSyncDue.ts` | 新規。窓の計算と due 判定（未設定 / 直後 / 窓ちょうど / パース不能 / 未来） |
| `test/services/google/test_calendarCollectionSync.ts` | `dueCalendarGroups` の絞り込み |
| `docs/CHANGELOG.md` | Unreleased に1件 |

## レビューで見てほしいところ

- **開始時スタンプの副作用**: 掴んだホストが「失敗」ではなく**ハング**した場合（Google が応答を
  返さないまま TTL 無しで待つ等）、マーカーは押されたまま release されない。窓を過ぎれば次の
  tick で due になるので恒久的な停止にはならないが、fetch 側のタイムアウトが効いている前提
- **窓の値**: 5分の猶予は hourly 前提では余裕がありすぎるくらいだが、壁時計整列のおかげで
  55〜60分の間には何も発火しないので害は無い、という読み
- **task def の自己参照**: `run` クロージャが `def.schedule` を実行時に読む形。overrides を
  追随させるために必要だが、素直な書き方ではないので意図が伝わるか
