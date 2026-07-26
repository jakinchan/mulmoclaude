# feat(calendar): Collection → Google Calendar push button (#2598)

## Request

ベータフィードバックより:

> MulmoClaudeのGoogleカレンダーのSync機能はG Cal -> Collectionの一方向しかできないですか？
> コレクションとG Calの双方向同期ができたらと思って気軽に始めたのですが、サクッと設定ができず詰まってます。。。
> 何に詰まっているのかがまだ言語化できていないのですが、MulmoClaudeと会話が噛み合っていない。

続けて「collection -> google の同期ボタンってつくれる？」

## なぜ「設定が見つからない」のか

一方向しか存在しないので、探しても無い。`GoogleCalendarSyncZ` は `calendarId` と `map` の2フィールドだけで、
書き戻しを表現する語彙が無い (`schemaZ.ts:602-611`)。ヘルプも "Edits they make locally are overwritten
the next time Google reports a change to that event" と明言していた
(`google-calendar-collection.md`、この PR で "What sync does" 節を書き換えるまで)。

Agent 側から見ても選択肢が2つしかない — pull 設定を書く (`googleCalendar` ブロック) か、`google` ツールで
単発のイベントを作る (#2569) か。ユーザーが求めた「両者を繋ぐ設定」は語彙に無いので、会話が噛み合わない。

## 決定事項

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| ローカル削除の反映 | **v1ではやらない** | `calendarDeleteEvent` は全参加者からイベントを消し不可逆 (`google.md:50-52`)。用途は create/update で足りる |
| コンフリクト（両側編集） | **スキップして報告** | どちらのデータも壊さない |
| UI | **push ボタンを別に追加** | どちらの方向が走ったか明示的。既存 Sync (pull) は無変更 |
| 新規レコードの event id | **client-set id** | Google の `events.insert` は呼び出し側指定 id を受ける (base32hex, 5-1024)。`generateItemId()` は8桁hex で条件を満たす → 再キーイング不要 |

client-set id を選んだ理由をもう少し: create 後に返ってきた実 id へレコードを付け替える方式は、
付け替えの取りこぼし = 次の pull で**重複レコードが生える**という復旧しにくい失敗になる。
client-set id なら失敗は Google が 409 を返すだけで、ローカルの状態は動かない。

### 409 の扱い — 取り込みは「書かない場合」だけ許す

baseline はレコード単位で保存するので 409 は稀だが、書き込み直後に落ちると
「イベントは在るが baseline が無い」状態になり、次の push が create を再試行して 409 を踏む。

ここで既存イベントを無条件に取り込んで PATCH するのは**危険**。409 は
「前回 push の未保存 baseline」だけでなく「**無関係なイベントが同じ id を持っている**」でも起きる
（別 workspace が同じ `generateItemId()` で 32bit id を振れば衝突しうる）。取り込んで PATCH すると
他人のイベントを書き換える。

なので 409 経路は**一切書き込まない**:

- リモートのイベントが既にレコードと一致している場合のみ取り込む（`mayAdoptExisting`）。
  一致しているなら書くものが無く、baseline を記録するだけなので Google 側は変わらない
- 一致しなければ対処法つきで報告する — Sync を押せばレコードと baseline の両方が書かれ、
  そのあとは通常どおり push できる。拒否は行き止まりではない

一致判定は秒の表記差（`09:30` / `09:30:00`）をまたぐ必要がある。またがないと、手入力した時刻の
レコードは永久に取り込めない。

## 設計上の本題 — 差分検出には「Google が最後に何と言ったか」が必要

現状 pull は Google の値を**正規化して**保存し、元の値をどこにも残していない。
そのため「ローカル編集」と「未編集」が原理的に区別できない。これが唯一の本質的な追加実装。

### shadow state は hash ではなく生の Google 値を持つ

`<workspace>/data/calendar/.push-state.json` に `calendarId → { eventId → 最後に見た CalendarEventSummary }`。
置き場所は sync token と同じ (`calendarSyncStore.ts:16-18`) — workspace リセットと連動させるため。

hash で足りそうに見えるが、**生の値でないと push が組み立てられない**:

`toCollectionDateTime` はタイムゾーンオフセットを意図的に捨てる (`collectionDateTime.ts:12-14`
「オフセットは適用せず DROP する。そうすればユーザーが Google 上で読む時刻がそのまま保存され、
sync を走らせたマシンに依存しない」)。加えて終日イベントは `2026-05-12` → `2026-05-12T00:00` になる
(`collectionDateTime.ts:33`)。つまりコレクションに保存された値からは:

- **元のオフセットが復元できない** — `+09:00` だったのか `Z` だったのか分からない
- **終日イベントだったことが復元できない** — 00:00 の時刻付きイベントと同じ形

生の Google 値を持っていれば両方復元できる:

| shadow の生 `start` | ローカル値 | push する形 |
| --- | --- | --- |
| `2026-05-12T08:45:00+09:00` | `2026-05-12T09:30` | `{ dateTime: "2026-05-12T09:30:00+09:00" }` — 元のオフセットを再利用 |
| `2026-05-12` (終日) | `2026-05-12T00:00` (未編集) | 変更なし扱い — 終日を時刻付きに壊さない |
| `2026-05-12` (終日) | `2026-05-13T00:00` | `{ date: "2026-05-13" }` — 終日のまま日付を動かす |
| shadow 無し (ローカル新規) | `2026-05-12T09:30` | `{ dateTime: "2026-05-12T09:30:00", timeZone: <カレンダーの timeZone> }` |

最後の行のために `CalendarSummary` に `timeZone` を足す (`toCalendarSummary`, `calendar.ts:122`)。
ホストのローカルタイムゾーンは使わない — 「値がマシン依存になる」のは
`collectionDateTime.ts` がまさに避けた失敗なので、同じ罠を push 側で踏むことになる。

### 分類ルール（純関数、テスト対象）

**2段構え**にする。Google を引くのは「ローカルが変わっている」と分かったレコードだけなので、
大きいコレクションでも API 呼び出しが変更件数に比例する。

段1 — Google に触らず、レコード × shadow だけで分類:
`planRecord(eventId, local, shadow, map, primaryKey, fields)`

- `create` — shadow に無い（ローカル新規）
- `unchanged` — ローカル値 == 正規化(shadow)
- `changed` — 差分のあった**フィールド名の配列**を返す（段2 と PATCH の対象）

段2 — `changed` のときだけ対象 eventId を個別に GET し、
`conflictingFields(shadow, current, changed)` で shadow と Google 現在値を突き合わせる:

- 空 → ローカルのみの編集なので PATCH する
- 非空 → 両側編集なのでスキップして報告

コンフリクト判定を**フィールド単位**にしているのが要点。Google が「ローカル編集が触っていない
フィールド」を変えただけなら PATCH はそこを含まないので、コンフリクトではない。イベント全体を
比較すると、この push を理由なく拒否してしまう。

`local-delete` は分類ではなく別関数 `locallyDeletedIds(shadow, presentIds)` — shadow にあるが
ディスクに無い id。v1 は件数だけ報告する。

「Google 現在値」を取るのに incremental sync (`syncCalendarEvents`) は使わない —
**sync token を消費してはいけない**（pull が同じウィンドウを二度受け取れなくなる）。

段2 の GET と PATCH の間にも隙間があるので、GET した `etag` を `If-Match` で送り返す。
Google が 412 を返したらコンフリクト扱い。これが無いと「両側編集を壊さない」という約束に
1往復ぶんの穴が残る。

### push できるフィールド

map 可能な6つ (`schemaZ.ts:597`) のうち `htmlLink` と `status` は Google 側 read-only。
push は `summary / start / end / colorId` のみ。`status` をマップしたコレクションで push を押しても
その列は無視する（エラーにはしない — pull 用に張ったマッピングを push が否定するのは筋が悪い）。

`CalendarEventInput` / `UpdateCalendarEventInput` は今 flat な `startDateTime: string` しか表現できず、
`start: { dateTime }` 固定で送っている (`calendar.ts:152,170`)。終日と明示 timeZone を表現するため
`CalendarEventTime = { dateTime: string; timeZone?: string } | { date: string }` を追加し、
既存の flat フィールドは `google` ツール互換のためそのまま残す。

## 触るファイル

| ファイル | 変更 |
| --- | --- |
| `packages/core/src/google/calendarPushState.ts` (新) | shadow state の read/write。`calendarSyncStore.ts` の writeQueue パターンを踏襲 |
| `packages/core/src/google/collectionPush.ts` (新) | 分類 + push 実行。`syncCalendarForCollection` と対になる `pushCalendarForCollection` |
| `packages/core/src/google/pushDateTime.ts` (新) | 逆変換（上の表）。純関数 |
| `packages/core/src/google/calendar.ts` | `CalendarEventTime` 追加、`CalendarSummary.timeZone` 追加、単一イベント GET |
| `packages/core/src/google/collectionSync.ts` | pull 成功時に shadow state を更新（生の Google 値を持っているのは pull なので、ここで書くのが正しい） |
| `server/api/routes/collectionCalendarPush.ts` (新) | レスポンス整形。`collectionCalendarRefresh.ts` と同型 |
| `server/api/routes/collections.ts` | route 追加 |
| `src/config/apiRoutes.ts` | `collections.push` |
| `CollectionHeader.vue` | ボタン + `pushLabel` computed |
| `src/lang/*.ts` (8ロケール) | ラベル + 結果メッセージ |
| `packages/core/assets/helps/google-calendar-collection.md` | 「ローカル編集は上書きされる」を更新し push ボタンを説明 |

排他は既存の `withKeyedLock` / `calendarLocks` (`collectionSync.ts:140,158`) をそのまま使う。
push と pull が同じカレンダーで同時に走ると、pull が読んだウィンドウを push が追い越して
shadow state が実際より新しくなる。

## テスト（実装済み: 新規 67 + e2e 4）

- `test/services/google/test_pushDateTime.ts` (26) — 逆変換の表を全行。オフセット再利用、
  `Z` 維持、終日維持、終日の日付移動、shadow 無し時の timeZone 付与、時刻を発明せず null を返す
  ケース。**pull → push の round trip がバイト一致すること**を性質として固定（ここが壊れると
  ユーザーが触っていないイベントを黙って書き換える）
- `test/services/google/test_calendarPushPlan.ts` (33) — 分類ルール + shadow のマージ。
  重点は否定側:「終日イベントを触っていないのに update と判定しない」(`2026-05-12` vs
  `2026-05-12T00:00`)、「継承色を編集扱いしない」(Google の `""` vs レコードのキー欠落)、
  「read-only フィールドにマップされた列の編集を無視する」。コンフリクトはフィールド単位で、
  ローカル編集が触っていないフィールドの Google 側変更は誤検出しない
- `test/routes/test_collectionCalendarPush.ts` (8) — 未リンク / 非カレンダーコレクション /
  read-only カレンダーが「0件成功」に見えないこと
- e2e `collection-calendar-push-button.spec.ts` (4) — ボタンの出現条件、route への POST、
  未リンクエラーと skip 理由が画面に出ること

`calendarPushState.ts` の並行書き込みは `calendarSyncStore.ts` の writeQueue をそのまま踏襲した
ので、純粋な `mergeShadow` を固定するにとどめた（FS 並行性そのものは既存テストの対象）。

## 実装中に判明した設計上の差分

- **正規表現を分解した** — 秒を `(?::(\d{2}))?` で表すと量指定子が入れ子になり ReDoS lint
  (`security/detect-unsafe-regex`) が落ちる。`split` ベースの `parseStoredDateTime` に変更
- **`fieldText` を1本化した** — 分類側と push 側で同じ「absent / null / `""` を同一視する」
  正規化が必要だったので `pushPlan.ts` から export して共有。オブジェクトは `String()` の
  `[object Object]` ではなく JSON 化する（別物同士が等価判定されて編集が黙って捨てられる）
- **`CalendarEventInput` の span を union にした** — 終日と明示 timeZone を表現するため。
  「どちらも渡さない」が型で書けなくなる副作用がある一方、`google` ツールの既存呼び出しは無変更

## v1 のスコープ外

- ローカル削除の G Cal 反映（決定事項の通り）
- 自動 push（スケジューラ）— ボタンのみ。自動化は shadow state と分類ルールが実運用で
  信用できると分かってから
- 参加者・繰り返し・リマインダーの編集 — map できるフィールドの範囲外
- コンフリクトの UI 上での解決 — 件数の報告のみ

## Docs

`google-calendar-collection.md` の "Edits they make locally are overwritten the next time Google
reports a change to that event" は push ボタン追加後は不完全になる。Agent はこの文を読んで
ユーザーに説明するので、pull / push の役割分担と「push しないまま pull すると編集は失われる」
という順序依存を明記する。

## Release notes

- `@mulmoclaude/core` は `assets/helps/*` が変わるので minor bump + launcher の dep range
  （launcher 自身の `version` は触らない）
