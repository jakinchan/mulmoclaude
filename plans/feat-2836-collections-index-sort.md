# feat(collections): コレクション一覧の並び順をユーザーが選べるようにする (#2836)

## 背景

コレクション一覧の並び順は slug の辞書順に固定で、利用者が変える手段が無い。そのため「並び順を整えたい」
という軽い要望が「slug を改名する」という重い操作（新 slug で作り直し → データ移送 → 旧削除）に誘導されて
いる。実際に Discord でその経路を辿った報告があり、移行後も旧 slug のデータを指したままでデータ喪失の
一歩手前だった。

表示名（title）は dataPath と結合していないためいつでも安全に変えられる。並び順のキーを
「slug 順 / 表示名順」で切り替えられるようにすれば、「順番を変えたい → 表示名を直す」に誘導でき、
slug に手を入れる動機を減らせる。

## 方針: ソートは UI に閉じる

並び順の発生源はコードベースに1箇所しかない。

```ts
// packages/core/src/collection/server/discovery.ts:288
return [...merged.values()].sort((left, right) => left.slug.localeCompare(right.slug));
```

**ここは触らない。** `discoverCollections()` の戻り値の順序は一覧 UI 以外にも共有されているため:

| 消費者 | 用途 |
|---|---|
| `server/api/routes/collections.ts` | 一覧 API |
| `server/remoteHost/handlers/listCollections.ts` | モバイル（Remote Host）一覧 |
| `packages/core/src/collection-watchers/watcher.ts` | コレクション監視 |
| `packages/core/src/collection/server/ontology.ts` | Map タブ（slug 順前提） |

ソートは `CollectionsIndexView.vue` の computed の中だけで行い、discovery 側は canonical order のまま
据え置く。これにより API・エージェント・監視・モバイルの見え方は一切変わらない。

## 変更点

1. **`packages/plugins/collection-plugin/src/vue/collectionIndexSort.ts`（新規）**
   - `CollectionIndexSort = "slug" | "title"`
   - `sortCollectionsForIndex(list, key, locale)` — 純粋関数。`Intl.Collator(locale, { numeric: true })` で
     比較し、**同名タイトルのタイブレークは slug**（安定順序の担保）。
   - localStorage の read/write（既存 `collectionViewMode.ts` と同じ形。不正値は握って既定値に落とす）。
2. **`CollectionsIndexView.vue`** — sort state + computed + トグル UI。既存のフィルタチップ行に相乗り
   （チップは readonly コレクションがある時だけ出るので、行自体を `justify-between` に組み替えて
   ソートトグルは常時右寄せ）。コレクションが 2 件未満のときはトグルを出さない。
3. **i18n** — `collectionsView.sort.{label,slug,title}` を 8 ロケール（en/ja/zh/ko/es/pt-BR/fr/de）に lockstep で追加。
4. **テスト**
   - `test/utils/collections/test_collectionIndexSort.ts` — 純粋関数の unit test（既存
     `test_tableSortDisplay.ts` と同じ配置規約）。
   - `e2e/tests/collection-index-sort.spec.ts` — 実ブラウザでカードの並びが切り替わること、
     リロード後も保持されることを断定。

## 明示的にやらないこと

- **discovery.ts のソート変更**（上記のとおり波及先が広い）。
- **モバイル（Remote Host）側**への同機能追加。desktop だけ並びが変わるため端末間で見え方は割れるが、
  モバイルは別 UI・別導線なので本 issue のスコープ外とする。必要なら追って別 issue。
- **FeedsView** の並び順。同じ index パターンだが対象外（一覧間で基準が割れるのは許容、軽微）。
- **表示名を編集する UI**。title は skill 側 schema にあり、現状 UI からは編集できない。本 issue の狙いを
  完全に満たすには編集導線も要るかもしれないが、まずソートキー切替だけ入れて様子を見る。PR に明記する。
- **五十音順**。日本語タイトルの辞書順は五十音順にならない（漢字が読み順に並ばない）が、OS のファイル
  一覧と同じ挙動なので issue の方針どおりそのまま入れる。読み仮名は持たせない。

## 確認事項

- ピン留めの並び順は壊れない。一覧は `reconcileShortcuts(collections)` を呼ぶが、
  `src/composables/useShortcuts.ts` の `reconcile()` は既存 `shortcuts.value` の順序を保ったまま
  prune / title 更新するだけで、渡された配列の順序を採用しない（#2519 の手動ピン順と無干渉）。
  念のため、渡す配列はソート前の `collections.value` のままにする。
- `localeCompare` の既定ロケールはブラウザ依存なので、UI ロケール（`useCollectionI18n()` の `locale`）を
  明示的に `Intl.Collator` へ渡す。
- 既存 e2e はカードの可視性しか見ておらず順序を断定していないため、影響しない。

## リリース

`@mulmoclaude/collection-plugin` は publish 済みパッケージ。npm 版ユーザーへ届けるには version bump +
依存レンジ sweep + タグ付き publish が別途必要（本 PR では行わず、通常のリリースフローに委ねる）。
