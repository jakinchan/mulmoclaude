# fix(calendar): `calendars.get` を捨てて timeZone / accessRole を events.list から取る (#2735)

## 背景

#2602 の検証 spec（#2664）を実走した [報告](https://github.com/receptron/mulmoclaude/issues/2602#issuecomment-5155879218)で、
L-GCAL-01〜04 が 4 本とも入口で `HTTP 403 — "Request had insufficient authentication scopes."` になった。
同じ token で `events.list` / `events.insert` は 200。403 は `calendars.get` だけ。

原因はテストではなく実装。アプリが要求するスコープ（`GOOGLE_SCOPES`）は

- `calendar.events`
- `calendar.calendarlist.readonly`
- `tasks`
- `drive.file`

の 4 つで、Calendars.get が受け付けるスコープ
（`calendar.readonly` / `calendar` / `calendar.app.created` / `calendar.calendars` / `calendar.calendars.readonly`）に
**1 つも重なっていない**。`GOOGLE_SCOPES` は broker 連携でも local 連携でも共通なので、
`getCalendar()` は **どのアカウントでも必ず 403** になる。Calendar v3 の doc から書かれ、実 200 を一度も観測していなかった関数。

## 影響

`getCalendar` の本番側の唯一の呼び出しは `collectionPush.ts` の `liveCalendarMeta` の
「calendarList に無いカレンダー」フォールバック。

- calendarList に載っているカレンダーへの push は無事（一覧から timeZone と accessRole が取れるので `calendars.get` を呼ばない）
- #2602 項目 5 の unlisted カレンダーへの push は**必ず失敗する**。「役割チェック無しで続行する」つもりの経路が、
  1 件も書く前にスコープ 403 で `failed` outcome になる

## 方針

`events.list` のレスポンスは top-level に `timeZone` と `accessRole` を持ち、`calendar.events` スコープで叩ける
（[Events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) の Response body / Authorization scopes）。
**push が既に書き込みに使っているスコープで、up-front gate が要る情報が両方とも取れる。**

| | 旧（`calendars.get`） | 新（`events.list`） |
|---|---|---|
| timeZone | 取れる（が 403 で到達しない） | 取れる |
| accessRole | **無い**（calendarList 固有のため） | 取れる |
| 必要スコープ | `calendar` 系（未取得） | `calendar.events`（取得済み） |

### 変更点

1. `packages/core/src/google/calendar.ts`
   - `getCalendarMeta(accessToken, calendarId): Promise<CalendarMeta>` を追加。`events.list` を `maxResults=1` で 1 回叩き、
     top-level の `timeZone` / `accessRole` を返す。イベント本体は使わない
   - `getCalendar()` と `CalendarSummary` を返す calendars.get 経路を削除（`index.ts` の re-export も）。
     呼べない関数を残すと次の人が同じ罠を踏む
2. `packages/core/src/google/collectionPush.ts`
   - `liveCalendarMeta` のフォールバックを `getCalendarMeta` に差し替え
   - unlisted でも本物の `accessRole` が取れるので、`CalendarWriteTarget.accessRole` の
     「null = 不明」というコメントを実態に合わせる。読めるが書けない unlisted カレンダーは
     per-event の不透明な 403 ではなく **up-front gate で本当の理由**が返るようになる
3. `e2e-live/tests/calendar-push.spec.ts`
   - timeZone 取得を `getCalendarMeta` に寄せる（L-GCAL-01〜04 が走れるようになる）
   - L-GCAL-05 は unlisted で `accessRole` まで確認する
   - L-GCAL-07 の期待値に `unpushedIds`（#2620 で追加）を足し、**`CalendarCollectionPushResult` の型注釈を付ける**。
     次に結果の型が増えたら `yarn typecheck:e2e-live` が落ちる（今回は落ちなかったので実走まで気付けなかった）
4. `test/services/google/test_googleCalendar.ts` に `toCalendarMeta` の unit test を足す

### やらないこと

- **スコープを広げる（`calendar.readonly` を足す）選択肢は取らない。** 同意画面で要求する権限が増える一方、
  得られるのは events.list で既に取れる情報だけ。最小権限を崩す理由が無い
- UI 項目（#2602 の Push / Sync ボタンの並び）はこの PR の対象外

## 検証

- `yarn format` / `yarn lint` / `yarn build` / `yarn typecheck` / `yarn test`
- **実 Google での確認は別途必要**（このリポの手元には linked account が無い）。
  spec 自体が検証手段なので、#2602 の報告者に `yarn test:e2e:live:calendar` の再実行を依頼する
