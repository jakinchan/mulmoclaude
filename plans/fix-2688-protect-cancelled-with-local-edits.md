# fix(calendar): Google が消したイベントでも、ローカル編集があれば record を消さない (#2688)

## Request

#2684（PR #2687）で、pull が record を**上書き**する前にローカル編集を確認するようにした。
しかし**削除**経路には同じガードが掛かっていない。`applyEvent` (`collectionSync.ts:127-130`):

```ts
if (event.status === CANCELLED_EVENT_STATUS) {
  const deleted = await store.delete(event.id);   // ← 無条件
  return classifyDelete(event.id, deleted.kind);
}
```

Google 側でイベントがキャンセルされると、その record がローカル編集されていても**黙って消えます**。
#2683 / #2684 が閉じたのと同種の損失で、こちらだけ残っていた。

## 起票時の見立ての訂正

issue 本文には「保護に倒すと『sync first と言われて sync すると消される』ループになるので、
出口の UX 設計から必要」と書いたが、**不正確だった**。

- `withheld` はエラーではないので **token は進む**
- Google はキャンセルを再送しないので、**次回以降の sync はそのイベントを見ない**
- よって状態は安定し、ループしない

行き止まりだったのは**メッセージだけ**。`collectionPush.ts` が返す
`"the event no longer exists in Google — sync first, then re-create it"` が、
sync しても何も起きない状況で「sync しろ」と言い続ける。

さらに #2684 で `shadowUpdates` に carry-forward が入ったので、**baseline の据え置きは既存機構で
そのまま成立する** ── キャンセルされたイベントに `null`（baseline 削除）を出す経路も、`withheld` に
入れば run 開始前の値が書き戻される。追加の仕組みは要らない。

## 方針

書き込み側と削除側で**同じガードを1回だけ**通す。読み取りも1回に集約する。

判定を純粋関数として切り出し、`applyEvent` は薄いディスパッチャにする ── この判定は #2666 / #2683 /
#2684 が繰り返し間違えてきた箇所なので、I/O 抜きで固定できる形にしておく。

```ts
export function applyPlanFor(existing, event, hasUnsentEdit): "withhold" | "delete" | "write" {
  if (existing !== null && hasUnsentEdit(existing, event.id)) return "withhold";
  return event.status === CANCELLED_EVENT_STATUS ? "delete" : "write";
}
```

**ガードが status より先**なのが要点。「Google がこれをどうしたか」より「ローカルに失うものがあるか」が
先に効く。

## 出口 — メッセージを実態に合わせる

`collectionPush.ts` の該当メッセージを書き換える。ユーザーが取れる行動は2つ:

- その record を削除する（Google と揃う）
- 別レコードにコピーする（新しい id で create として上がる）

**「同じ id で再作成できる／できない」は主張しない。** Google がキャンセル済みイベントの id を
再利用させるかは未検証で、根拠のないことをメッセージに書かない。

## スコープ外

- **UI での明示的な選択肢**（「ローカルを残す / 消す」を出す）。メッセージで出口は成立するので、
  UI 追加と i18n は別途判断
- **ローカル削除された record の baseline 掃除**。`locallyDeletedIds` が報告するだけで baseline
  エントリは残る。本 issue とは別の話

## テスト

`applyPlanFor` を純粋関数として:

- 編集済み record + キャンセル → `withhold`（削除しない）
- 同期済み record + キャンセル → `delete`
- record 無し + キャンセル → `delete`（存在しないものの削除は `classifyDelete` が `skipped` にする）
- 編集済み record + 通常イベント → `withhold`（#2684 の挙動が変わらないこと）
- 同期済み record + 通常イベント → `write`

`shadowUpdates`:

- **キャンセルされたイベントが held のとき、`null` ではなく run 開始前の baseline が残ること**
  ── これが「conflict を報告し続けられる」条件
