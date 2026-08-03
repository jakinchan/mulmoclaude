# fix: #2736 スイープが見つけた実バグの根本原因を直す (#2765)

## 背景

PR #2756（NUIA スイープ）が実バグ 6 件を発見したが、方針が「明示化するだけ・挙動は据え置き」
だったため根本原因が残っている。現 main で実測したところ 3 件が未対応、3 件はスイープの
「明示化」がそのまま修正になっていた。

| # | 状態 | 備考 |
|---|---|---|
| 1 core scheduler 無言死 | **残** | `dailyTargetMs` が null → `isDue` false、ログ無し |
| 2 task-scheduler バッチ全滅 | **残** | 再現済み: `RangeError: Invalid time value` |
| 3 mulmoscript | 済 | `if (!beat) return { ok: true, audio: null }` |
| 4 edgar | 済 | `columnAt` の `?? ""` |
| 5/6 accounting period | **残** | 再現済み: `{kind:"month",period:"banana"}` が通る |

## 方針（ユーザー判断を反映）

**#1 は `log.error` + never-due**。throw は選ばない — 他 consumer が今「黙って死んでいるタスク」を
持っていた場合に**起動クラッシュへ変わる**ため。沈黙さえ消えれば、あとはその consumer が直せる。

## 変更点

### 1. `packages/core/src/scheduler/task-manager.ts`

- `dailyTargetMs()` の隣に `isMalformedDailyTime(schedule)` を置き、`registerTask` / `updateSchedule` の
  両方から呼んで `log.error` を出す。**登録は従来どおり成功**し、`isDue` も従来どおり `false`。
- 両方に入れる理由: `updateSchedule` は `applyScheduleOverride` 経由で実行時に呼ばれるので、
  登録時だけ見ていると後から入った不正値を取り逃す。

### 2. `packages/scheduler/src/windows.ts`

- `nextWindowAfter` の daily / weekly 分岐で、`parseTimeToMs` の結果が有限でなければ `null` を返す。
- これだけで `listMissedWindows` は即 break（0 件）、`isDueAt` は `false`、`catchup.ts` は NaN を見ない。
- **`parseTimeToMs` の公開シグネチャ (`number`) は変えない** — `@receptron/task-scheduler` は公開パッケージで、
  戻り値型の変更は破壊的変更になる。NaN を返すこと自体は据え置き、使う側で止める。

### 3. `packages/plugins/accounting-plugin/src/server/bodyFields.ts`

- `optionalReportPeriod` に形式チェックを足す: `month` の `period` は `YYYY-MM`、
  `range` の `from`/`to` は `YYYY-MM-DD`。
- 不正な形式は**同ファイルに既にある 400 の枠組み**（#2692/PR #2694 が導入）に合流させ、
  受理できる形を文言で示す。LLM 呼び出し元が自分でペイロードを直せる形にする。
- `from`/`to` も `period` と同じ未検証クラスなので併せて締める（`endDateOfPeriod` は `period.to` を
  そのまま `asOf` に返すため、同じ経路でゴミが載る）。

### 4. `packages/core/src/collection/core/calendarGrid.ts`（nit）

- `splitClusters` の `reduce` が毎要素で配列をコピーしている（O(n²)）ので push ベースに戻す。
- `assignLanes` は**テストが 1 件も無い**ので、先に**ランダム差分テスト**を足してから触る。
  現行実装の出力を固定値として持つのではなく、性質（同一クラスタ内でレーンが重ならない・
  入力順で返る・`lanes` がクラスタの最大レーン数）で検証する。

## 検証

- 各バグに**現状で落ちる**テストを先に足し、修正後に緑になることを確認する
  （メモリの教訓: 緑のテストは、修正を戻して赤くなるまで何も証明しない）。
- `yarn format` / `lint` / `typecheck` / `build` / `test`。
- publish は別途。`@mulmoclaude/core` と `@receptron/task-scheduler` と
  `@mulmoclaude/accounting-plugin` の 3 本が対象になる。
