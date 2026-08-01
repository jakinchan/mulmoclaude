# fix(feeds): 取り込みがユーザーの列を消さないようにする (#2696)

## Request

#2679 から始まったカレンダー同期の一連（#2683 / #2684 / #2688）を閉じたあと、
**同じクラスの穴が他に残っていないか**を探して見つけたもの。カレンダー側は塞がったが、feeds には
同じ形がそのまま残っていた。

## 何が壊れているか

### ① upsert がレコードを丸ごと置換する

`upsertItems` は取り込んだアイテムをそのまま書いていた:

```ts
const result = await store.write(itemId, item);
```

`writeItem` は `JSON.stringify(item)` を書くだけなので、**レコードは丸ごと置換される**。
結果、**ユーザーが feed のレコードに足した列は次の refresh で消える**。feed collection は
読み取り専用ではなく、`ingest` を宣言しているだけの通常の collection として UI で編集できる。

カレンダー側が `mergeIntoExisting` を作って塞いだのと同じ問題で、`collectionProjection.ts` の
docstring がその理由を明記しているのに、**feeds はその修正を受け取っていなかった**。

### ② prune も同じ損失を、一手遅れて起こす

`pruneFeed` は `maxItems` の窓から外れたレコードを削除する。**ローカルで注記されたかは見ていない**。
①を直しても、注記は毎回の refresh を生き延びたあと、記事が古くなった時点で消える。

## 方針

- **①**: `mergeIntoExisting` を通す。取り込み値は自分が持つフィールドで勝ち、それ以外は残る
- **②**: 「feed が生成していない列に中身がある」レコードは prune しない

`mergeIntoExisting` は `packages/core/src/google/collectionProjection.ts` にあったので、
**`collection/core/project.ts`（既存の record projection モジュール）へ引き上げた**。feeds が google を
import する形は作らない。`@mulmoclaude/core/google` の公開面は変えていない（index の export 元だけ移動）。
`docs/shared-utils.md` にも1行追加した（カタログ規約）。

## 「feed が生成したフィールド」をどう知るか — テストに前提を壊された

最初は `ingest.map` のキーだけを根拠にした。in-tree の retriever（`rss` / `httpJson`）は
**`ingest.map` を通して射影する**ので、map = 生成フィールドで正しい。

しかし既存の `packages/core/test/feeds/test_engine.ts` が落ちた。`registerRetriever` で登録した
fake が、map に無いフィールドを返していたためで、**その形は本番でも起こり得る**（`registerRetriever`
は公開されている）。map だけを信じると、そういう feed では全レコードが「ユーザーの列を持つ」と
判定され、**cap が黙って効かなくなる**。

そこで判定材料を2つの和にした:

- **その回に実際に取り込まれたアイテムのキー**（観測。どんな retriever でも正しい）
- **宣言された `map` のターゲット**（何も取れなかった回には観測が無いので、こちらが支える）
- 加えて primaryKey

## 「ローカルな中身」の判定に空値を数えない

UI からレコードを保存すると、宣言済みフィールドが**空文字のまま**書かれ得る。空を「ユーザーの列」と
数えると、**一度でも開いたレコードが prune 対象外**になり cap が死ぬ。よって
`undefined` / `null` / `""` は数えない。

**マップ済みフィールドへの編集も数えない。** feed は一方向なので、そこへの編集は次の refresh が
上書きするのが設計。耐久性があるのはローカルの「列」の方で、守るべきはそちら。

## 受け入れる副作用

注記されたレコードが残るぶん、**feed が cap を超え得る**。黙って超えると数が説明できなくなるので、
`kept` を info ログに出す。

## テスト

`test/workspace/feeds/test_feedLocalContent.ts`:

- `ingestedFields` — map のターゲット + primaryKey / **map に無いが観測されたフィールド** /
  何も取れず map も無い場合
- `mergeIntoExisting` — feed が生成しない列が残る / マップ済みは feed が勝つ / 新規レコード
- `hasLocalContent` — ローカル列を保護 / 未編集は prune 可 / **空値は数えない** /
  マップ済みフィールドの編集は保護しない / 非文字列のローカル値

既存の `packages/core/test/feeds/test_engine.ts`（cap の回帰）はそのまま通る。

## スコープ外

- **agent ingest**。`refreshOne` が先に分岐し、`upsertItems` も `pruneFeed` も通らない
  （エージェントが自分でレコードを管理する）
- **マップ済みフィールドの編集の保護**。一方向の feed では設計上の一時的な値
