# enum フィールドの `default`（Tier 1） (#2839)

## 何を作るか

`schema.json` の enum フィールドに `default` を書けるようにし、**新規レコードの初期値**にする。

```json
"status": { "type": "enum", "values": ["todo","doing","done"], "required": true, "default": "todo" }
```

- UI の「+ 追加」がその値で開く
- `putItems mode:"create"` で、行がそのフィールドを持たなければ埋まる
- `upsert` / `merge` では**適用しない**（既に答えを持つレコードの編集だから）

issue の Tier 2（全型のリテラル）と Tier 3（`today` / `now`）はやらない。動機になっている実例は
enum 2つ（`status` / `priority`）で、Tier 1 で満たされる。

## 既存ユーザーへの影響をゼロにする設計

`default` は**今まで Zod の既定（strip）で黙って捨てられていた**。つまり既に書いている人が居る
（issue の報告者がまさにそれ）。素朴に「Zod で `values` の一員かを検証」すると:

`discovery.ts` は検証に落ちたスキーマを **warn 1行でスキップする**（コレクションが一覧から丸ごと消える）。
typo の `default` が残っているだけで、ユーザーのコレクションが消える。

そこで検証を**書き込み側だけ**に置く。

| 層 | 扱い |
| --- | --- |
| Zod（読み書き共通） | `default: z.string().optional()` のみ。**membership を見ない** → 読みで既存スキーマを落とさない |
| `putSchema`（書きのみ） | `values` の一員でなければ拒否。理由と許容値をメッセージに載せる |
| 実行時（`fieldDefaultValue`） | 範囲外なら「default 無し」として扱う |

`manageTool.ts` には「putSchema が通したものが discovery で落ちてはならない（コレクションが隠れる）」
という不変条件がコメントで明記されている。**書きが読みより厳しい**のはこの向きに反しないので安全。

実行時の fail-soft は1行。無くても「UI の select が空で描画され、保存時に行が弾かれる」で
一応転ぶが、**画面に説明が無いエラー**になるので入れる価値がある（#2863 と同型の配慮）。

## 実装

| ファイル | 変更 |
| --- | --- |
| `core/schemaZ.ts` | `EnumFieldZ` に `default` を optional 追加（membership は見ない、理由をコメント） |
| `core/fieldDefaults.ts` | 新規。`fieldDefaultValue` / `schemaDefaults` / `firstUnknownDefault` |
| `server/manageTool.ts` | putSchema に write-only チェック、putItems の `create` で `{...schemaDefaults, ...row}` |
| `CollectionView.vue` `openCreate()` | 空文字の代わりに default |
| `assets/helps/collection-skills.md` | enum の項に `default` の説明（エージェントが発見できないと機能しない） |

## テスト

- unit 9件（`fieldDefaults`）
- ツール経由 7件（create で埋まる / 行の値を上書きしない / upsert・merge では適用しない /
  putSchema が範囲外を拒否 / 正しい default は書ける / **範囲外の default を持つコレクションが
  読み込めること** ＝ 互換性の保証）
- e2e 3件（Add フォームが default で開く・default 無しの列は空のまま / 既存レコードの編集は
  自分の値を出す / 範囲外の default は空で開きコレクションは無事）

e2e は **UI の prefill を戻すと2件落ちる**ことを確認済み（プラグインと app を再ビルドして実測）。

## publish

`@mulmoclaude/core`（schemaZ / fieldDefaults / manageTool）と `@mulmoclaude/collection-plugin`（UI）の
両方に差分があるので、npm 利用者に届けるには次の publish 波で両方を出す必要がある。
