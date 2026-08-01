# fix(calendar): autoPush の無い collection にも pull 保護を入れる (#2683)

## Request

#2679（`.push-state.json` のクロスプロセス lost update）を調査した結果、issue 本文が想定していた
被害「baseline が進んで conflict を検出できなくなる」は **lost update からは起きない**ことが分かった。
代わりに、同じ被害を**並行性なしで**引き起こす経路が2本見つかったので分離した。本 plan はそのうち
片方（#2683）を閉じる。もう片方は #2684。

## 何が壊れているか

`syncCalendarGroupNow` (`collectionSync.ts:315-339`) は必ずこの順で動く:

```text
① push     … autoPush の collection を Google へ送り、送れなかった id 集合 unpushed を得る
② fetch    … Google から変更ウィンドウを取る
③ apply    … events を record ファイルに書く（unpushed のものは除外）
④ baseline … events を .push-state.json に書く（unpushed のものは除外）
```

`unpushed` が③④の保護集合。ところが①の実体は `collections.filter(c => c.schema.googleCalendar?.autoPush)`
(`collectionSync.ts:203`) なので、**`autoPush` を宣言していない collection はループに入らない**。

結果 `unpushed` map に entry が作られず:

- `unpushedFor` が `undefined` を受けて `NOTHING_UNPUSHED`（空集合）を返す (`collectionSync.ts:150-153`)
- `allUnpushed` にも何も寄与しない (`collectionSync.ts:169`)

③は `pullableEvents(events, ∅)` で全イベントを素通しし、`mergeIntoExisting` は
**map が覆うフィールドで Google が勝つ** (`collectionProjection.ts:46-54`)。④は baseline も進める。

→ 未送信のローカル編集が Google の値で上書きされ、baseline もその先へ進むので、
**次の push は conflict を検出できない**。編集は痕跡なく消える。**同期が1回走るだけで成立する。**

## なぜ既存の救済が届いていないか

`protectUnsentEdits` (`collectionSync.ts:182`) は #2666 でまさにこの形の救済として入った。docstring 自身が
「role が reader に落ちた calendar は push を丸ごと拒否するのに pull は走り、未送信のローカル編集を
全部上書きしながら baseline をその先へ進めた」と書いている。

しかし呼ばれるのは **「autoPush があって、その push が失敗した」ときだけ** (`collectionSync.ts:213, 216`)。
「autoPush が無いので push が一度も走らない」collection は、状態としては同じなのに救済の外にいる。

## 方針

**「push が走らなかった」の扱いを揃える。** 理由（失敗したのか、そもそも宣言が無いのか）に関係なく、
未送信のローカル編集は保護対象にする。

①を全 collection で回し、`autoPush` が無いものには `protectUnsentEdits` をそのまま使う。
`unsentLocalEdits` は record と baseline の比較なので、新しい判定ロジックは要らない。

### なぜ「全 record が編集扱いになって pull が凍る」事故が起きないか

`baselineRecord` (`pushPlan.ts:88-96`) は `toCollectionRecord` を通す ── **pull が record を書くときと
同じ projection**。`collectionProjection.ts` の冒頭がこれを明言している:

> A leaf on purpose. The pull writes records with it and the push rebuilds its baseline with it,
> which is what makes "unchanged" mean exactly "the pull would produce this".

よって同期済みの record は baseline と一致し、保護集合には入らない。比較対象は `pushableMap` が
narrowing した**書き込み可能フィールドのみ**なので、`htmlLink` / `status` のような読み取り専用列や
map に無いローカル列は判定に影響しない。

## 実装

`collectionSync.ts` の①を2関数に割る（現状の `pushAutoCollections` は分岐を足すと 20 行を超えるため）:

- `pullProtectionFor(collection, workspaceRoot)` — 1 collection ぶんの保護集合を返す
  - `autoPush` が無い → `protectUnsentEdits`
  - ある → push し、`pushed` なら `unpushedIds`、それ以外・例外なら `protectUnsentEdits`
- `pushAndProtect(collections, workspaceRoot)` — 全 collection を回して map を作る（旧 `pushAutoCollections`）

呼び出し側 (`syncCalendarGroupNow`) の形は変わらない。

## 受け入れる副作用

1. **`PROTECTION_UNKNOWN` の適用範囲が広がる。** `protectUnsentEdits` が record を読めず `null` を返すと、
   その collection は pull されず retryable error になり、token と baseline がグループ全体で据え置かれる
   (`collectionSync.ts:161-166`)。これまで非 autoPush collection はこの経路に入らなかった。
   **意図的にこの側に倒す**: 保護が計算できないまま pull すると、保護対象そのものを壊す（#2666 と同じ判断）。

2. **同期ごとに非 autoPush collection の record を list する I/O が増える。** `unsentLocalEdits` は
   `store.list()` を呼ぶ。push 失敗パスでは既に払っているコストだが、非 autoPush collection では
   毎回になる。大きな collection では効くので、負荷が問題になるなら baseline との差分だけを見る
   軽量版を後で検討する（本 plan の範囲外）。

3. **挙動が変わる。** これまで「非 autoPush collection のローカル編集は次の pull で Google に揃う」
   だったものが、「保護され、baseline も据え置かれるので、手動 Push 時に conflict として報告される」になる。
   これは #2620 の設計どおりの挙動であり、黙って消すよりは正しい。

## テスト

`test/services/google/` に追加する。

- 非 autoPush collection のローカル編集が保護集合に入ること
- 同期済み（baseline と一致する）record は保護集合に入らないこと ── 全件凍結しないことの回帰テスト
- autoPush collection の既存挙動（`pushed` → `unpushedIds` / 失敗 → `protectUnsentEdits`）が変わらないこと
- `protectUnsentEdits` が `null` を返した非 autoPush collection が `PROTECTION_UNKNOWN` になること

## スコープ外

- #2684（保護集合が①のスナップショットなので fetch 中の編集を守れない）。こちらを直すと本 plan の
  早期計算は冗長になるが、#2684 は `restartFullSync` が `clearCalendarShadow` で判定材料を消す問題を
  抱えており、明確に重い。先に本 plan を入れる。
- #2679（クロスプロセス lost update）。データを壊さないことが判明したので優先度は最後。
