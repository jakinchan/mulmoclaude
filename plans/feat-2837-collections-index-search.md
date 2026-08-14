# コレクション一覧を検索欄で絞り込む (#2837)

## 何を作るか

`/collections` の一覧（installed タブ）に小さな検索欄を足し、**title と slug の部分一致**（大小文字無視）で
カードを絞り込む。状態は永続化しない。サーバ変更なし。

## なぜタグではなく検索か

issue の元案は「利用者が定義するタグ + チップで絞り込み」だが、先に検索を入れる。

- **タグは全既存コレクションが「未分類」から始まる。** issue 自身が最大の懸念として挙げている
  （エージェントが作成時に付けないと絞り込みが機能しない）。検索は初日から全件に効く
- スキーマ変更・エージェント向け docs（#2312 と同じ問題）・レジストリのエクスポート、どれも要らない。
  `CollectionSummary` は `slug` / `title` を既に持つのでクライアント側だけで完結する
- issue が挙げる設計上の宿題2つ —「チップ行に2軸が混ざる」「チップの表示条件」— は、
  テキスト欄がチップとは別の入力である以上どちらも発生しない

**カバーしないもの**: 「人間用 / AI内部用の区別・既定で非表示」。検索は能動的に絞るだけで既定の一覧を変えない。
ここは永続的な印が要るので別 issue に切り出す（tag 一式が必要かは、検索が入った後で判断する）。

## 実装

**検索対象は title と slug だけ** — カードに出ているもの。`CollectionSummary` 全体を
レコード用の `itemMatchesQuery` に通すと `source` / `readonly` にも当たり、"project" や "true" で
黙って絞れてしまう。

マッチャ自体は core の `itemMatchesQuery`（`packages/core/src/collection/core/textSearch.ts`）を
そのまま使う。小文字化 + `includes` の規則を2箇所に書かない。

新規 `packages/plugins/collection-plugin/src/vue/collectionsIndexFilter.ts`（純粋関数）:

- `INDEX_FILTER_CHIPS` / `CollectionIndexFilter` — 既存のチップ定義を view から移す
- `collectionMatchesQuery(collection, query)`
- `filterIndexCollections(collections, filter, query)` — チップと検索の AND

`CollectionsIndexView.vue`:

- 検索欄（`search` アイコン + input + クリアボタン）。レコード検索の `CollectionToolbar` と同じ見た目
- チップ行と同じ行に置く。チップは今までどおり読み取り専用コレクションがあるときだけ出る
- 該当なしの表示（`search_off` + 文言 + クリア）。レコード一覧の該当なしと同じ形

i18n は 2 キー追加（`indexSearchPlaceholder` / `indexNoMatches`）を **8ロケール全部**に。
「検索をクリア」は既存の `clearSearch` を再利用する。

## テスト

- unit: `test/plugins/collection/test_collectionsIndexFilter.ts` — チップ × クエリの組み合わせ、
  空クエリ、前後空白、大小文字、`source` / `readonly` に当たらないこと
- e2e: `e2e/tests/collection-index-search.spec.ts` — 実ブラウザで入力 → カードが減る → クリアで戻る →
  該当なし表示

## 関連

- #1874 — 起点。残課題のうち「フィルタ/検索」をここで閉じる
- #2836 — 表示順（別軸）
