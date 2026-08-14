# 未設定の embed（`idField` が空）を fail-soft 表示にする (#2863)

## 症状

任意（`required` でない）の `ref` を `idField` に取る `embed` は、その値が空のときレコード詳細で
赤い「レコードが見つかりません」カードになる。id を差し込む位置が空なので
「`projects` に「」のレコードが見つかりません」という文になる。リンク切れではなく
**まだ設定していないだけ**なので、正常なレコードが恒常的にエラー表示になる。

## 契約

`packages/core/src/collection/core/schemaZ.ts` の `EmbedFieldZ`:

> `idField` (…); an absent/empty value resolves fail-soft to "no record"

`schema.ts` の `embedTargetId()` も「どちらも当てはまらないときは空文字 — 呼び出し側が
'no record' として描く」と書いて空を正常系で返している。赤枠 + `error_outline` は fail-soft の
表示ではない。

## 原因

2つの状態が1つの boolean に潰れている。

1. `embedTargetId()` — `idField` が空なら `""`
2. `useCollectionRendering.renderers.ts` `buildEmbedViews()` — `found: Boolean(item)`。
   「参照が空」も「参照先が無い」も同じ `false`
3. `CollectionEmbedView.vue` — 分岐は `v-if="view.found"` と `v-else`（赤カード）の2本だけ

## 直し方

**`CollectionEmbedView.vue` の1ファイルだけ。core も i18n も触らない。**

区別に必要な情報はビューモデルに既にある（`recordId`）。赤カードの手前に
`v-else-if="!view.recordId"` を1本足し、他の空フィールドと同じ em-dash を描く。
固定 `id` の embed は `recordId` が空にならないので、per-record な `idField` の embed だけが拾われる。

採らなかった案:

- 文言（「未設定」等）を出す → `CollectionMessages` 経由で 8 ロケール全部の追従が要る。
  em-dash はパネル内の他の空フィールド（`ref` / boolean 欠落 / 各種 fallback）と揃うので、
  新しい語彙を増やすより既存の語彙に合わせる方が良い。
- `EmbedView.found` を3状態にする → 設計は綺麗だが `found` は公開済み API で core + plugin の
  2本リリースになる。描画分岐の修正にその代償は見合わない。

## テスト

- unit: `buildEmbedViews` に空 `idField` のケース。既存は `"ghost"`（リンク切れ）だけで、
  「`found: false` かつ `recordId: ""`」＝描画が分岐する状態を押さえていない
- e2e: `collection-embed-unset.spec.ts`。1コレクション3レコード（解決する / ghost / 未設定）で
  ①未設定は em-dash で赤カードが出ない ②ghost は今までどおり赤カード、を実ブラウザで確認する
  （Vue コンポーネントの単体テストはこのリポジトリに無いので、描画分岐の ground truth は e2e）

## 影響範囲

`idField` を持つ embed のうち storage フィールドが `required` でないもの。表示のみで、
保存経路・射影・サーバ側には触れない。
