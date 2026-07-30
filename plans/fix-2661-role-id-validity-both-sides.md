# role の食い違い警告が、id 側が不正なときに到達不能にする助言を出す

Issue #2661 · 直接の前段: #2656 (PR #2660) · 発見経路: PR #2660 のレビューループ中のセルフレビュー

## 何が残っていたか

`f7f6a53` (#2660) は `fileNameMismatchProblems` の助言を **ファイル名側**が不正なケースで
絞ったが、**id 側**が不正な対称ケースは絞られていなかった。

```console
$ fileNameMismatchProblems({ fileName: "designer.json", role: { id: "my role", ... } })
role id does not match its file name — delete / update take the file name,
not the id shown in the list; rename the file to "my role.json" or change the id to "designer"
```

`rename the file to "my role.json"` に従うと basename が `my role` になり、
`deleteRoleResult` の `isValidRoleId` チェック (`server/api/routes/roles.ts:66`) で
`Invalid role id 'my role'.` として弾かれる。**現状動いている `delete designer` を潰す助言**。

`RoleSchema.id` は素の `z.string()` (`src/config/roles.ts:34`) なので、手置きファイルでは
id 側が `^[a-zA-Z0-9_-]+$` を外れた状態で `loadCustomRoles` に届く。

## 直し方の原則

`isValidRoleId` は **保存可能な id** と **delete handle** の両方を門番している
(`roles-io.ts` 経由の `roleFilePath`、および route の事前検証)。したがって助言の各半分は、
それが `isValidRoleId` を通る間だけ提示できる。

| baseName | id | 到達可能な handle | 出す助言 |
|---|---|---|---|
| 有効 | 有効 | ファイル名 | rename か id 変更のどちらでも |
| 不正 | 有効 | なし | rename のみ（`f7f6a53`) |
| 有効 | 不正 | ファイル名 | id 変更のみ（rename は handle を失う） |
| 不正 | 不正 | なし | 有効な id を選び、ファイル名と id の両方に使う |

## 変更

- `server/workspace/roles.ts` — `mismatchMessage` を 4 分岐に。`rename` / `changeId` を
  それぞれ変数に切り出し、`lead` を共通化して 20 行以内に収める
- `packages/core/assets/helps/error-recovery.md` — 「rename か id 変更のどちらでも」の
  無条件記述を条件付きに。3 つの警告バリアントを列挙し、エージェントが助言を推測せず
  **警告行が名指しした選択肢だけ**を伝えるようにする
- `docs/extension-mechanisms.md` § 3.6 Role — 同じ例外を ②として追記

`assets/helps/*` を触るが `@mulmoclaude/core` は既に **1.10.1 (未 publish、npm の latest は
1.10.0)** なので同じ 1.10.1 に相乗りする。追加 bump / range 掃きは不要。

## やらないこと

- **`RoleSchema.id` にパターン制約を足す**。既存ワークスペースで id が不正なまま動いている
  role がスキーマ検証失敗で**一覧から消える**。#2656 が「どちらを正とするかは変えない」と
  決めた方針と同じ理由で、まず黙らないこと・誤った助言を出さないことだけを直す。
- **`isValidRoleId` の正規化 / 自動リネーム**。挙動変更になる。

## 検証

- 純粋関数のテスト 3 ケース（id 側不正 / 両側不正 / 既存の両側有効）を
  `test/roles/test_role_file_diagnostics.ts` に追加
- **`mismatchMessage` を `f7f6a53` の片側実装に戻すと新テスト 2 件が red** になることを確認
  （green の証明力の担保）
- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build` / `yarn test`
