# feat(calendar): Google Calendar 双方向同期を成立させる最小セット (#2620)

## Request

ベータフィードバック (#2620) より。2つのコレクションでそれぞれ別の Google カレンダーを
ミラーしており、どちらも双方向同期が必要:

- **ケース A** — コレクション側が一次情報。GCal は外部に見せるための従だが、GCal 側からも予定が入る
- **ケース B** — 共有カレンダー。どちらが正ということはなく、両側の変更を取り込みたい

現在は「マージロジックを Python スクリプトに、MCP 呼び出しをエージェントに分けた双方向同期」を
自作して運用している。pull は `description` / `location` が要るため、ネイティブの `google` ツール
ではなく claude.ai の Google Calendar コネクタ経由で取得している。

issue は6項目の機能要望として書かれている（繰り返しの親子キー / 取得フィールド追加 /
push フィールド追加 / フィールド単位マージ / push の自動実行 / ローカル削除の伝播）。

## 目的の再定義 — 6項目を実装項目として受け取らない

発行者がやりたいのは **「自作の Python 同期をやめる」** の一点。それを塞いでいるのは実質2つだけ:

1. `description` / `location` が往復しない → だから pull を claude.ai コネクタでやっている
2. push が手動 → だから同期サイクルを自分で回している

残りの4項目は、この2つが解ければ不要になるか、独立して後から純加算できる。

## 発見 — 項目4（フィールド単位マージ）は push 側が既に実装済み

`updateFromRecord` (`collectionPush.ts:236`) は、

1. ローカルで変更されたフィールドだけを取り出し (`locallyChangedFields`)
2. そのうち Google もベースラインから変更したものだけを衝突とみなし (`conflictingFields`)
3. 衝突が無ければ**変更フィールドのみ**を PATCH する

発行者が「こうしてほしい」と書いた規則そのもの。**欠けているのは pull 側だけ** で、pull は
ベースラインを一切見ずにレコードを丸ごと上書きする (`collectionSync.ts:118` → `io.ts:191` が
`JSON.stringify(item)` で全置換)。

つまり項目4は「マージエンジンを新設する」話ではなく、**pull に、push が既に出している判断を
尊重させる**話に縮む。

### 併せて判明した既存の破壊

全置換なので、`map` に無い列 —— ユーザが宣言した独自フィールド（メモ等）—— は
pull のたびに消える。これは今日すでに存在するデータ損失で、どの道を選ぶにせよ先に直す。

## 決定事項

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 実装範囲 | **A / B / C の3点のみ**（下記） | 発行者の目的はこれで達成される。残りは純加算で後から足せる |
| マージの粒度 | **検知はフィールド単位（既存のまま）、解決はレコード単位のスキップ** | push が既にそう動いている。pull を合わせると**非対称が消える** = 発行者の最大の不満が解ける |
| `updated` の追加 | **見送り** | 発行者が欲しがったのは自前で衝突検知するため。C がアプリ側で検知するので不要になる |
| 繰り返しの親子キー | **見送り**（別 issue） | 同期の正しさに影響しない。「大量更新に見える」のは表示の問題で、read-only フィールドとして後から純加算できる |
| 自動 push の UI | **作らない**（スキーマのキーのみ） | UI を足すと i18n 8ロケールと e2e が付いてくる。エージェントが `schema.json` に書ければ用は足りる |
| ローカル削除の伝播 | **見送り**（別 issue） | 不可逆。独立したオプトインとして別途 |
| 既定動作 | **完全に不変** | 無条件に変わるのは A だけで、A はデータを保持する方向にしか動かない |

## 変更 A — pull がマップ外の列を保持する

`applyEvent` (`collectionSync.ts:106`) が `store.write` の前に `store.read` し、
既存レコードに射影結果を重ねる:

```
{ ...existing, ...projected, [primaryKey]: event.id }
```

`store.read` は `storeFor()` に既にある (`store.ts:109`)。

### 副作用

- **イベントごとに read が1回増える**。初回フルシンクではレコードがまだ無く、`readItem` は
  `isRegularFile` の stat で null を返すだけなので実質無償。
- **`map` から外したフィールドの最終同期値が残る**（今日は消えていた）。挙動変更だが、
  「消える」より「残る」の方が安全側。ヘルプに1行足す。
- **UI 編集との競合窓**は現状と同等かむしろ縮む（今日は無条件の全置換）。`withCalendarLock` は
  UI をロックしないので窓自体は残る。

## 変更 B — `description` / `location` を pull と push の両方に追加

- pull: `CalendarEventSummary` (`calendar.ts:104`) / `toEventSummary` (`calendar.ts:152`) /
  `GOOGLE_CALENDAR_SOURCE_FIELDS` (`schemaZ.ts:597`) に追加
- push: `PUSHABLE_SOURCE_FIELDS` (`pushPlan.ts:15`) に追加
  - `description` は `buildEventPatch` (`calendar.ts:222`) に**既に実装済み**。`""` でクリアされる
    `undefined`/`""` の区別も既にある
  - `location` は `CalendarEventInput` / `UpdateCalendarEventInput` / `buildEventPatch` /
    `createCalendarEvent` のボディに新規追加が要る
- `buildPatch` (`collectionPush.ts:204`) に2フィールドの分岐を追加

### 副作用・互換性

- **`CalendarEventSummary` に必須2フィールドが増える** → 構築点は全部コンパイルエラーで出る。
  実際の構築点は `toEventSummary` とテストのフィクスチャのみ。
  `server/remoteHost/handlers/googleCalendar.ts:88` の `{ ...event }` は自動追従する
  （リモートホストの応答に2キー増える。純加算なのでモバイル側は無視して動く）。
- **`ShadowEvent` (`calendarPushState.ts:25`) も2つ増える** が、**移行は不要**:
  旧 `.push-state.json` にキーが無い → `fieldText(undefined) === ""`、
  Google も未設定の description を `""` で返す (`stringField`) → 一致。全件が
  「ローカル編集済み」に化ける事故は起きない。
- **既存の手入力列を `description` に map すると、次の push でその内容が Google に上がる。**
  これは `colorId` 等 既存の pushable フィールドと同じ挙動なので新種の危険ではないが、
  ヘルプに1行明記する。
- `description` は HTML を含む。**pull では生の値を保持し、正規化しない**（発行者の指摘どおり、
  正規化すると往復で GCal 側の書式が失われる）。ヘルプでは `text` 型を推奨する。

## 変更 C — push → pull を1サイクルとして自動実行（オプトイン）

スキーマに `googleCalendar.autoPush?: boolean` を追加（既定 = 未指定 = false）。
`googleCalendarSyncTaskDef` の毎時実行で、カレンダーグループの pull の**直前**に、
そのグループ内で `autoPush` が立っているコレクションの push を走らせる。

### 必須の実装詳細

1. **ロックの再入を避ける。** `pushCalendarForCollection` は自分で `withCalendarLock` を取り、
   `withKeyedLock` は再入不可なので素直に呼ぶと固まる。`pushNow` を `pushCollectionNow` として
   export し、手動ボタン（ロックを取る）と sync タスク（既にロックの中）の両方から使う。

   **実装中に判明**: pull が push を呼ぶと `collectionSync` ⇄ `collectionPush` が循環する
   （`collectionPush` → `collectionSync` の依存は `withCalendarLock` と、`pushPlan` 経由の
   `toCollectionRecord` の2本）。ESM の関数宣言なら実行時には動くが、依存方向の規約に反するので
   両方を leaf へ切り出した:
   - `calendarLock.ts` — `withKeyedLock` / `withCalendarLock`
   - `collectionProjection.ts` — `toCollectionRecord` / `mergeIntoExisting` / 射影の内部関数

   結果、依存は `collectionSync`（オーケストレータ）→ `collectionPush`（1ステップ）→ leaf の
   一方向になった。

2. **push が「送れなかった」と判定したレコードを pull が触らない。**
   `pushNow` が保護対象の record id 集合 (`unpushedIds`) を返す。

   **実装中に見直した点**: 当初 `conflict` / `skipped` / `error` の3種を対象にする想定だったが、
   **`skipped` を含めてはいけない**。`skipped` の理由のいくつか（「同じ id のイベントが既に
   Google にあり内容が違う」）は、**pull がレコードとベースラインを書くことで解消する**のが
   既存の設計 (`createOrAdopt` のメッセージが "press Sync to adopt it" と案内している)。
   保護するとその復旧経路が塞がり、そのレコードが永久に取り残される。
   よって保護は **`conflict` と `error` の2種のみ**（`isUnpushed`）。

3. **保護したレコードは shadow（ベースライン）の更新も飛ばす。** ← 最重要
   飛ばさないと `shadowUpdates()` がベースラインを Google の新値に進め、レコードだけが
   ローカル旧値のまま残る。すると次サイクルの push は
   「ローカルは変更されている / Google はベースラインと一致」と読んで**衝突を検知せずに
   ローカル値で GCal を上書きする**。飛ばせば、ベースラインが古いまま留まるので
   次サイクルでも同じ衝突が再検知され、ユーザが解消するまで報告が続く（安定）。

4. **保護したレコードについて、Google 側のその変更は再送されない。** 同期トークンは
   グループ単位で進むため。結果、レコードは古いまま残る = **ローカルを失うより安全な倒れ方**。
   ただし黙って古くなるのは避けたいので、`log.warn` で record id を出す。

5. **push の失敗が pull を止めない。** コレクションごとに try/catch し、warn を出して続行。

### 副作用・互換性

- **`GoogleCalendarSyncZ` は `.strict()` ではない** → 前方後方どちらも互換。
  旧ホストが `autoPush` 付きスキーマを読むと zod がキーを落として無視、
  新ホストが旧スキーマを読むと `undefined` = false。
- **既定 off なので、フラグを書かない既存ユーザの挙動は1ビットも変わらない。**
- **コスト**: 毎時、対象コレクションのレコード全件読み出しが1回増える。変更が無ければ
  Google API 呼び出しは0（`planRecord` がベースライン比較で弾く）。118件規模では無視できる。
- **ヘルプの書き換えが必須。** `packages/core/assets/helps/google-calendar-collection.md` は現在
  「There is no automatic write-back and no setting that enables one. …
  Do not go looking for a config key for it — there isn't one」と明記している。
  直さないとエージェントが**存在する機能を「無い」と断言する**。

## 実装手順

1. **A** — `applyEvent` の read-modify-write 化 + テスト（マップ外の列が残ること）
2. **B** — pull/push 双方に `description` / `location`。`location` の API 層追加を含む
3. **C** — `pushNow` の切り出し（挙動不変のリファクタとして単独で確認）
4. **C** — `autoPush` をスキーマに追加、sync タスクへ配線、保護 id の受け渡し、shadow 更新の除外
5. ヘルプ (`google-calendar-collection.md`) の書き換え。「Both directions, but only one of them
   automatic」節と「Order matters」の警告を、autoPush が有効な場合の記述に差し替える
6. `yarn format` → `yarn lint` → `yarn typecheck` → `yarn build` → `yarn test`

## テスト

更新が要る既存テスト:

- `test/services/google/test_googleCalendar.ts` — `toEventSummary` の新フィールド
- `test/services/google/test_calendarPushPlan.ts` — `PUSHABLE_SOURCE_FIELDS` の増加
- `test/services/google/test_calendarCollectionSync.ts` — 射影とシャドウ更新
- `test/workspace/collections/test_schema_google_calendar.ts` — `autoPush` の受理
- `test/routes/test_collectionCalendarPush.ts` — 応答形の変化があれば

新規に要るテスト:

- pull がマップ外の列を保持する（A の本体）
- 旧 `.push-state.json`（description/location キー無し）に対して、記述を map した直後の push が
  全件を「変更あり」と誤判定しないこと（B の移行不要性の固定）
- push が conflict/skipped/error にしたレコードを pull が上書きしないこと（C-2）
- **その同じレコードの shadow が更新されないこと**（C-3）— ここを落とすと次サイクルで
  GCal が黙って上書きされるので、リグレッションテストとして最重要
- `autoPush` 未指定のコレクションが sync 中に push されないこと（既定 off の固定）
- 自動サイクルがロックを再入しない（デッドロックしない）こと

## Items to Confirm / Review

- **`description` の HTML 正規化で push が毎回 `updated` になる懸念。** Google が PATCH した
  description を正規化して返すと、ベースラインは Google の正規化後、レコードは
  ローカル原文のままになり、以後 push のたびに同じ内容を再 PATCH し続ける
  （`comparableText` が秒表記のために解いたのと同型の罠）。C が有効なら直後の pull が
  Google の値をレコードに書き戻して収束するが、**手動 push のみ（C オフ）だとループしうる**。
  実機の GCal で1往復させて要確認。データ損失ではなく無駄な API 呼び出しと
  「永久に編集済みに見える」表示の問題。
- 保護レコードの Google 側変更が再送されない件（C-4）を、warn ログだけで足りるとするか、
  レコードに衝突マークを持たせるか。issue 本文は「どのレコードのどのフィールドが、
  ローカル値と GCal 値それぞれ何だったか」の提示を望んでいるが、UI を伴うので本 PR では見送る想定。
- `autoPush` というキー名でよいか（`push: { auto: true }` 等の入れ子にしない判断）。

## 見送る項目と理由

| 項目 | 理由 |
| --- | --- |
| `updated` | 自前の衝突検知用。C がアプリ側で検知するので不要になる |
| `recurringEventId` / `originalStartTime` | 同期の正しさに影響しない。53%が展開インスタンスでも A があれば上書きは無害。read-only フィールドとして後から純加算 |
| `transparency` / `attendees` / `conferenceData` / `eventType` | コレクションのフィールド型はスカラのみ (`schemaZ.ts:172`) なので、配列/入れ子は導出スカラの設計が要る。発行者自身「本題ではない」と明記 |
| フィールド単位の pull マージ | C のレコード単位スキップで粗すぎると分かってから。先に作ると read-before-write と衝突報告の複雑さを前借りする |
| ローカル削除の伝播 | 不可逆。独立したオプトインとして別 issue |

## リリース

`packages/core/assets/helps/*` が変わるので `@mulmoclaude/core` の version bump が必要
（`files: ["dist", "assets"]` で npm に載る）。publish 自体は本 PR の範囲外。
