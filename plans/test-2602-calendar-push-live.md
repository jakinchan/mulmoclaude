# test(calendar): Collection → Google push を実カレンダーで検証する (#2602)

## 背景

#2598 / #2600 で入った Push to Google は、**一度も実 Google に対して動かしていない**。
ユニットテストも e2e もすべて fake / mock で、API の形は「既存エンジンの実装」と
「Calendar v3 のドキュメント」から読んだだけ。観測された 200 は 1 件も無い。

#2602 が挙げる 6 項目は、どれも **Google 側の挙動についての主張** であり、
こちら側のコードをいくら読んでも真偽が決まらない。外部の ground truth
（= Google 本体の応答）に当てるしかない。

## 方針

`e2e-live/` に spec を 1 本足す（#2602 の「Suggested approach」どおり）。ただし
既存の e2e-live spec と違い **LLM もブラウザも使わない**。検証対象は
`@mulmoclaude/core/google` の関数群と Google Calendar API の契約なので、
Playwright は「実行と trace/report の器」としてだけ使う。

2 段構えにする。

| 段 | 何を叩くか | 何が分かるか |
|---|---|---|
| A. API 契約 | `calendar.ts` の関数を直接 | Google が本当にその形を受け、その status を返すか |
| B. push 経路 | `pushCalendarForCollection` を一時 workspace で | 機能として通しで動くか（baseline 永続化込み） |

A だけでは「push が実際に動く」ことは言えず、B だけでは「409 か 400 か」のような
status の断定ができない（push は status を握り潰して outcome に畳む）。両方要る。

### スコープ外にしたもの

- **UI**（Push ボタンと Sync ボタンの並び / 長い locale ラベル）。ブラウザで見る話なので
  `/pr-ui-test` かスクリーンショットの担当。この PR には含めない。
- **項目 5 の「共有されているがリストに無いカレンダー」の完全再現**。別アカウントから
  共有してもらう必要があり、CI でも手元でも自動化できない。env で id を渡された時だけ
  走る optional なテストにする（後述）。

## 前提（実行者が用意するもの）

アプリの OAuth スコープは `calendar.events` / `calendar.calendarlist.readonly` /
`tasks` / `drive.file` の 4 つ。**カレンダー自体の作成・削除権限は無い**
（それには full `calendar` スコープが要る）。したがって「テストが使い捨てカレンダーを
自動で作って消す」はできない。**人が Google Calendar の UI で作って id を env で渡す。**

| env | 必須 | 何を渡すか |
|---|---|---|
| `E2E_LIVE_GOOGLE_CALENDAR_ID` | ○ | 書き込んでよい使い捨てカレンダーの id |
| `E2E_LIVE_GOOGLE_READONLY_CALENDAR_ID` | — | 読めるが書けないカレンダー（例: 購読中の祝日カレンダー） |
| `E2E_LIVE_GOOGLE_UNLISTED_CALENDAR_ID` | — | 書けるが calendarList に無いカレンダー（項目 5） |

必須の env が無ければ describe ごと skip。optional な env が無い項目は
**その項目だけ** skip し、skip 理由に「何を用意すれば走るか」を書く
（黙って通過して「検証済み」に見えるのが一番まずい）。

イベントは毎回テスト側が作って `finally` で消す。id には nonce を入れて、
並列 worker や前回の失敗残骸と衝突させない。

## テスト項目と #2602 の対応

### A. API 契約

| # | #2602 | やること | 判定 |
|---|---|---|---|
| A-1 | 1, 2 | `toGoogleEventTime` が作る値をそのまま `createCalendarEvent` に渡す（offset 無し `dateTime` + `timeZone`、client 指定 id） | 201 相当で返り、id が指定どおり。読み戻した `start` が送った壁時計で始まる（= その zone で解釈された） |
| A-2 | 1 | 同じ id でもう一度 insert | `GoogleApiError.status === 409`（400 ではない） |
| A-3 | 3 | `getCalendarEvent` で etag を取り → 別経路で PATCH → 古い etag で `If-Match` PATCH | `status === 412`（409 でも 400 でもない） |
| A-4 | 4 | 終日イベントを作り、push と同じ手順（`toGoogleEventTime(local, previous, tz)`）で日付を動かす | 終日のまま（`date` であり `dateTime` ではない）／ exclusive end が 1 日ずれない |
| A-5 | 5 | `E2E_LIVE_GOOGLE_UNLISTED_CALENDAR_ID` があるとき: `listCalendars()` に無いことを確認 → `getCalendar` → 書き込み | `timeZone` が返り、書き込みが通る |
| A-6 | 6 | `E2E_LIVE_GOOGLE_READONLY_CALENDAR_ID` があるとき: 書き込みを試す | `status === 403` |

A-4 について: `CalendarEventSummary` は `date` と `dateTime` を 1 本の文字列に潰すので、
`"T"` を含むかどうかで終日かを判定する。読み戻した `end` が `start` の翌日のままであることも見る。

### B. push 経路

一時 workspace（`mkdtemp`）に `.claude/skills/<slug>/schema.json` と records を置き、
`configureCollectionHost` で core をその workspace に向けてから
`pushCalendarForCollection(slug, tmp)` を **実 deps のまま** 呼ぶ。HTTP ルートが呼ぶのと同じ関数。

| # | #2602 | やること | 判定 |
|---|---|---|---|
| B-1 | 1, 2 | ローカル生成レコード（hex id / offset 無し datetime）を push | `created: 1`, `skipped: []`, `errors: []`。Google 側に指定 id で存在し、summary と壁時計が一致 |
| B-2 | — | 続けてもう一度 push | `created: 0 / updated: 0`（baseline が効いている＝毎回書き直さない） |
| B-3 | — | summary を書き換えて push | `updated: 1`、Google 側に反映 |
| B-4 | 6 | 読み取り専用カレンダーを指す schema で push | `kind: "read-only"`（権限の話として返る。「API が有効か」ヒントではない） |

B-4 は 403 を踏む前の **up-front gate** を通る（購読中の read-only カレンダーは
calendarList に `accessRole: "reader"` で載るため）。`writeFailure` の 403 → 権限メッセージ
分岐は「リストに無くかつ書けない」カレンダーでしか踏めず、それは別アカウントが要る。
A-6 で「Google が 403 を返すこと」だけ押さえ、分岐自体は未カバーと明記する。

## 実装メモ

- 新規 fixture `e2e-live/fixtures/live-google.ts` に env 読み取り / skip 判定 /
  一時 workspace 構築を置く。spec 側は筋書きだけにする。イベントの後始末
  (`deleteEventQuietly`) は唯一の利用者である spec 側の local function に置く
  （`test.info()` を使う＝ runner 依存なので、下記の理由で fixture には置けない）。
- **fixture は `@playwright/test` に依存させない。** seed する workspace は
  collection engine との contract（`discoverCollections` が受理する schema、
  push が読む `googleCalendar` block、`storeFor().list()` が返すレコード）だが、
  Google grant が無いと live spec は 8 件すべて skip されるので、この contract は
  放っておくと誰にも見張られない。runner 非依存にしておけば
  `test/e2e-live/test_calendarCollectionWorkspace.ts` から通常の `yarn test` で
  当てられる（既存の `test/e2e-live/` の作法どおり）。
- **`E2E_LIVE_GOOGLE_CALENDAR_ID` が `primary` なら拒否する。** イベントを作って
  消す spec なので、宛先の誤りだけは避けたい。`primary` はエンジン自身の既定値でも
  あり、最も踏みやすく最も破壊的な誤りにあたる。token を読む前に落とす。
- **`test:e2e:live:calendar` だけ `ensure:playwright-browsers` を呼ばない。**
  `page` / `context` / `browser` のどの fixture も使わないため。
  `PLAYWRIGHT_BROWSERS_PATH` を空ディレクトリに向けて実測で確認する。
- `configureGoogleHost` は呼ばない（未設定でも silent logger で動く設計）。
  `configureCollectionHost` は必須（`discoverCollections` が host の paths を読む）。
- 実行スクリプトは `test:e2e:live:calendar`。`E2E_LIVE_REPORT_SUBDIR=calendar` で
  report を分ける（既存カテゴリの慣習どおり）。
- `E2E_LIVE_NO_LLM=1` の CI matrix には **入れない**。LLM は使わないが実 Google 認証が要り、
  CI に token は無い。必須 env が無ければどのみち skip される。
- `docs/e2e-live-testing.md` に「Google 認証が要る spec」の節を足す。この spec は
  「実 LLM」でも「fake-echo」でもない第三のカテゴリなので、表に載せないと次の人が迷う。

## 実行後にやること

走らせた結果 6 項目のどれかが **仮定と違っていたら、それは実装バグ**。
その場で直さず #2602 に観測結果を書き、別 issue / 別 PR に切る（このPR は検証手段の追加）。

特に項目 2 は、通ったら `packages/core/assets/helps/google.md` の
「date-time は offset 必須、無いと 400」という記述が push 経路について誤りであることの
証拠になるので、doc 修正を別途起票する。
