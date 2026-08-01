# fix(calendar): pull の保護を書き込み直前に判定する (#2684)

#2683 の上に積む（同じ関数群に触るため）。

## Request

#2679 の調査から分離した2本目。#2683 が「保護集合が最初から空」を閉じたのに対し、こちらは
**「保護集合が古い」**を閉じる。どちらも「保護を①の時点で決め打ちする」という同じ構造から出ている。

## 何が壊れているか

`syncCalendarGroupNow` はこの順で動く:

```text
① push     … autoPush の collection を Google へ送り、保護集合 unpushed を得る
② fetch    … Google から変更ウィンドウを取る            ← 数秒〜数分
③ apply    … events を record ファイルに書く（unpushed のものは除外）
④ baseline … events を .push-state.json に書く（unpushed のものは除外）
```

`unpushed` は①時点のスナップショット。**②の最中にユーザーが record を編集すると、その編集は
`unpushed` に載らない。** ③が Google の値で上書きし（`mergeIntoExisting` は map が覆うフィールドで
Google が勝つ）、④が baseline も進める。

→ 次の push から見ると record と baseline が一致している = ローカル編集など無かったことになり、
**conflict は永遠に検出されない。編集は痕跡なく消える。**

窓の広さは2段階:

- **増分同期** — ②が返すのは Google 側で変わったイベントだけなので、被害には *同じ窓で Google 側でも
  変わっていた* ことが要る（＝本物の conflict が黙って Google 勝ちで解決される）。窓は API 1往復
- **フルウォーク** — 410 復旧 (`restartFullSync`) や初回同期では②が全イベントを返す。Google 側の変更すら
  不要で、**walk が走っている数分間に編集された record は片っ端から該当する**

プロセスを跨ぐ必要はなく、#2679 のカレンダーロックでも塞げない（ユーザーの record 編集はロックを取らない）。

## 方針 — 保護を「集合」から「書き込み直前の判定」へ

③が1イベントを書く直前に、**その record が baseline と食い違っていないか**を見る。食い違っていれば
書かない（＝ローカル編集を残す）。判定と書き込みの間に窓が無いので、TOCTOU が消える。

### 壁：フルウォークは判定材料を消してしまう

`restartFullSync` は `clearCalendarShadow` を呼ぶ (`collectionSync.ts`)。baseline が空になった状態で
③が走るので、「baseline が無い」を保護と解釈すると **full re-walk が丸ごと凍る**。かといって
非保護と解釈すると、いちばん窓が広いフルウォークで何も守れない。

**解: ①の直後に baseline のスナップショットを取り、その run の判定にはスナップショットを使う。**

スナップショットを取る位置が重要:

- **①より前ではだめ。** push は record ごとに baseline を書く (`collectionPush.ts`)。push 前の
  スナップショットは push が送った分だけ古く、送ったばかりの record が「ローカル編集あり」と誤判定され、
  baseline が据え置かれて偽陽性 conflict になる
- **①の直後、②より前が正しい。** これは「この run が読み始めた時点で、ワークスペースが
  『Google はこうだ』と信じていた状態」そのもの。それ以降に編集された record だけが食い違う
- `restartFullSync` は②の1回目の fetch の後に走るので、①直後のスナップショットは clear より前に取れる

## 実装

1. `ApplyOutcome` に `{ kind: "withheld" }` を足す
2. `CalendarCollectionSyncResult` に `withheld: string[]` を足す（構築箇所4つを更新）
3. `unsentEditGuard(schema, baseline)` — 判定を返す述語。`applyEventsToCollection` が
   **collection ごとに1回だけ**作り、`applyEvent` へ渡す。`applyEvent` は `store.read` の直後、
   書き込み直前にこれを呼び、真なら `withheld`
   （map の構築を毎イベント繰り返さないための形。Sourcery review #2687）
4. `applyEventsToCollection` が `withheld` を集める
5. `syncCalendarGroupNow` が①直後にスナップショットを取り、`heldBack(unpushed, results)` で
   ③の `withheld` を `allUnpushed(unpushed)` と union して④の `shadowUpdates` に渡す
   ── ③の保護と④の保護は**必ず一致していなければならない**（`pullableEvents` の docstring が明記）

### held-back の baseline はフルウォークで消えてしまう（レビュー中に発見）

④で「省く」だけでは足りない。増分同期なら `.push-state.json` はマージ書き込みなので既存エントリが
残るが、**`restartFullSync` は先に `clearCalendarShadow` を呼ぶ**ので、そこでは省略がそのまま
エントリ消滅になる。すると次の push は conflict しているレコードを**新規 create として扱い**、
Google の duplicate-id 409 を踏んで `createOrAdopt` に拒否される ── conflict として報告されるべき
ものが別のエラーに化ける。

`shadowUpdates` に第3引数（carry-forward）を足し、held-back のイベントについては **run 開始前の
スナップショット値を書き戻す**。増分・フルウォークのどちらでも同じ挙動になる。

baseline を持たない held-back（ローカル作成でまだ push していないレコード）は carry しない ──
無いものを捏造すると、次の push が「同期済み」と誤読するため。

### token は進めてよい、baseline は進めてはいけない

`withheld` はエラーではないので `windowFullyLanded` を false にしない ── token は進む。Google が
そのイベントを再送しなくても、record はローカル編集を保ったままで、次の push が conflict として
報告するので失われない。**進めてはいけないのは baseline だけ**。

## スコープ外（意図的に手を付けない）

- **キャンセル（削除）経路。** Google 側で消えたイベントの record がローカル編集されていた場合、
  今は削除される。これも同種の損失だが、保留すると「Google に無い record が残り、次の push が
  『sync first』と言い続ける」という別の行き止まりを作る。#2684 は書き込み側の TOCTOU に絞る
- **①の早期計算の撤去。** 書き込み直前の判定は①の `unpushedIds` を包含するが（送れなかった record は
  record ≠ baseline なので必ず引っかかる）、`PROTECTION_UNKNOWN`（record が読めない → その collection は
  pull しない）は書き込み判定では表現できないため①は残す。冗長だが安全側

## テスト

`test/services/google/test_calendarCollectionSync.ts` に3ブロック。

`unsentEditGuard`:

- baseline と一致する record は保護しない（全件凍結しない回帰）
- スナップショット以降に編集された record は保護する
- baseline を持たないイベントは保護しない（初めて受け取るイベントを止めない）
- map が覆わないローカル列の差分は保護理由にしない
- Google 側だけが動き record が無変更なら保護しない

`heldBack`:

- ①の未送信と③の拒否を union すること／collection をまたいで union すること
- union に入ったイベントが `shadowUpdates` から外れること（③と④の一致）

`shadowUpdates` carry-forward:

- held-back は run 開始前の値を書き戻し、Google の現在値へは進めないこと
- held-back でないものは通常どおり進むこと
- baseline を持たない held-back は carry しないこと
- 第3引数を渡さない従来の呼び出しは挙動が変わらないこと

**「withheld が token を止めない」は構造で担保**している（`windowFullyLanded` は `errors` しか見ず、
`withheld` は別フィールド）。`windowFullyLanded` は private なので直接のテストは書いていない。
