# role のファイル名と id が食い違っても無言 / id 重複も無言

Issue: #2656 · 発見経路: #2649 (PR #2655) 実装中のセルフレビュー

## 症状の構造

Issue #2649 が塞いだのは「**読み込みに失敗した**ファイルが無言で消える」経路。残っているのは
「**読み込みは成功するのに整合していない**」2 ケースで、こちらは今も無言で通る。

| 実際に起きたこと | 現状の見え方 |
|---|---|
| ファイル名 ≠ 中身の `id` | 一覧には出るのに delete / update が `Role '<id>' not found.` |
| 2 ファイルが同じ `id` | 片方だけが使われ、負けた側について何も出ない |

原因は id の出どころが 2 系統あること:

- `server/workspace/roles.ts` — `loadCustomRoles` / `getRole` は id を**ファイルの中身**から取る
- `server/utils/files/roles-io.ts` — `roleExists` / `deleteRole` / `saveRole` は id を**ファイル名**として扱う

アプリ経由 (`manageRoles`) の role は `saveRole(role.id, role)` なので常に「ファイル名 == `id`」。
つまり①②が起きるのは**手で置いた / 手でリネームした**ときだけ — #2649 と同じ構図。

## どちらを正とするかは変えない

ファイル名 / 中身の `id` のどちらかに寄せると、**既存ワークスペースの role が一覧から消える**
（食い違ったまま動いている role がある場合）。挙動を変えずに済む範囲で、まず**黙らないこと**だけを直す。
`loadCustomRoles` の戻りも `getRole` の勝敗判定も現状のまま。

## 変更

### `server/workspace/roles.ts`

成功 outcome にファイル名を残す（`RoleFileOutcome` の成功側を `LoadedRole = { fileName, role }` に）。
`problem` を作る純粋関数を 2 つ足し、`loadCustomRoles` の既存の 1 箇所の `log.warn` に合流させる。

- `fileNameMismatchProblems({ fileName, role })` — **純粋関数、export**。`path.basename(fileName, ".json")`
  と `role.id` が違えば両方を出す。直し方（ファイルをリネーム / `id` を変更）まで message に載せる。
- `duplicateIdProblems(loaded)` — **純粋関数、export**。同じ `id` を持つファイルが 2 件以上あれば、
  **採用した側 (`used`) と無視された側 (`ignored`)** をファイル名で出す。
  どちらが勝つかは `readdir` 順（= `getRole` の「先に見つかった方」）なので、順序依存の判定は
  純粋関数側に閉じ込めてテストで固定する。

### ドキュメント / help

- `docs/extension-mechanisms.md` § 3.6 Role — #2649 の warn 一覧に「ファイル名との食い違い」「id 重複」を追記。
- `packages/core/assets/helps/error-recovery.md` — **新しい症状**なので既存節（「一覧に出ない」）とは別に
  「**一覧には出るのに delete / update が not found**」節を追加。エージェントが警告行を推測せず
  利用者に訊くよう、既存節と同じ形で書く。
  - `assets/helps/*` は npm に載るので `@mulmoclaude/core` の bump が必要だが、workspace は既に
    **1.10.1 (未 publish、npm の latest は 1.10.0)** なので同じ 1.10.1 に相乗りする。追加 bump は不要
    = 宣言側 range の掃き直しも不要。

## テスト

`test/roles/test_role_file_diagnostics.ts` に追記（#2649 のファイルと同じ症状系統なので分けない）。

- 純粋関数
  - `fileNameMismatchProblems`: 一致なら空 / 食い違いなら両方が出る / message に直し方が出る
  - `duplicateIdProblems`: 重複なしなら空 / 3 件重複で `used` は先頭・`ignored` は残り / 別 id は混ざらない
- 統合（一時ワークスペース + `captureStderr`）
  - `designer.json` に `"id": "myrole"` → warn に両方の名前が出て、**role 自体は読める**（握り潰しの意図は保つ）
  - 同じ `id` の 2 ファイル → warn に id と 2 つのファイル名が出る。
    どちらが勝つかは `readdir` 順なので統合テストでは**勝敗を assert しない**（純粋関数側で固定済み）
  - ファイル名 == `id` の role だけのときは**何も出ない**（既存の無音テストの回帰）
