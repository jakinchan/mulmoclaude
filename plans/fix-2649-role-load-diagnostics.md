# 手で置いた role ファイルが無言で消える

Issue: #2649 · 発見経路: #2648 (docs, CLOSED) のレビュー → ドキュメント側の訂正は #2652

## 症状の構造

`loadCustomRoles()` の `catch { return []; }` が、**性質の違う4つの失敗を1つの結果に潰している**。

| 実際に起きたこと | 現状の見え方 |
|---|---|
| JSON 構文エラー | role が出ない |
| `RoleSchema` 検証失敗 | role が出ない |
| 読み取り失敗 (権限等) | role が出ない |
| 空ファイル | role が出ない |

さらに `.filter(endsWith(".json"))` で落ちた `.md` / `.jsonc` は try にも入らない。

握り潰し自体は正しい設計（壊れた1ファイルで起動を止めない）なので、**握り潰しをやめるのではなく、握り潰したことを記録する**。

## 診断面が他に無いことは確認済み

issue のコメントに記録済み。`GET /api/roles/list` は `loadCustomRoles()` の戻りをそのまま返すので UI からも不可視、`log.warn("roles", "manage: error")` は manage アクション（UI/ツール経由）専用で手置きファイルの読み込み経路には効かない。`saveRole` は `JSON.stringify` で書くのでアプリ経由の role は常に妥当 — **失敗するのは手で置いた/手で編集したときだけ**で、そこにだけ診断が無い。

## 変更

### `server/workspace/roles.ts`

読み取り（I/O）と解釈（純粋）を分ける。

- `parseRoleFile(fileName, raw)` — **純粋関数、export**。`{ role }` か `{ problem }` を返す。空 → JSON 構文 → スキーマ の順に判定するので、利用者が受け取る理由が実際の失敗原因と1対1に対応する。テストは env も一時ディレクトリも要らない。
- `readRoleText(fileName)` — `readTextUnderSync` の `string | null` と throw を `{ text }` / `{ problem }` に畳む。`null` は ENOENT のみ（`workspace-io` の契約）なので「readdir が挙げた直後に消えた」= 走査中のリネーム/削除として報告する。
- `loadCustomRoles()` — outcome を集め、problem を `log.warn("roles", ...)`、role を返す。

`RoleFileProblem` は `{ message, data }` で持つ。ログ整形は呼び出し側 1 箇所だけになり、純粋関数側は「何が起きたか」だけを組み立てる。

zod の `issues` を生の配列で渡すとテキストシンクで JSON の壁になるので、`path: message` を `"; "` で連結した1行に畳む（`summarizeRoleIssues`）。issue が求めた「どのフィールドか」がそのまま読める形。

`.json` 以外のエントリは 1 行にまとめて警告する。dotfile (`.DS_Store` 等) は role を置く意図が無いので対象外 — `collection/server/discovery.ts` の `name.startsWith(".")` と同じ扱い。

### 抑制（dedup）は入れない

`getRole()` はエージェントのリクエスト毎に呼ばれるので、壊れたファイルがある間は警告がリクエスト毎に出る。一度だけに絞る実装も考えたが**入れない**:

利用者の動線は「role が出ない → ログを見る」。初回だけ警告する設計だと、ログを見始めた時点で既に警告が流れ終わっていて **元のバグ（何も出ない）と区別がつかない**。設定を直せば止まる警告なので、量は問題に見合っている。`collection` の discovery も走査毎に警告している。

## ドキュメント / help

- `docs/extension-mechanisms.md` § 3.6 Role — #2652 が入れた「無言で握り潰される」記述を、実際の warn の内容（ファイル名 + 理由）に差し替える。
- `packages/core/assets/helps/error-recovery.md` — エージェントが実行時に読む復旧手順に「手で置いた role が一覧に出ない」節を追加。6 つの warn メッセージ（`readRoleText` 2 + `parseRoleFile` 3 + `ignoredEntryProblems` 1）を列挙し、**どれなのかを推測せず利用者にその行を訊く**よう指示する。既存の `[collections-registry] registry config entry rejected` 節と同じ形。
  - `assets/helps/*` は npm に載るので `@mulmoclaude/core` を 1.10.0 → **1.10.1** に上げ、宣言側 13 箇所（8 パッケージ）の range を `^1.10.1` に掃く。npm への publish 自体は `/publish` の仕事なので本 PR には含めない（consumer の次のリリース前に必要）。

## テスト

`test/roles/test_role_file_diagnostics.ts`

- 純粋関数 `parseRoleFile`: 妥当な role / 空 / 空白のみ / 末尾カンマ / issue の再現ケース（`{"id","name"}` のみ → `icon`・`prompt`・`availablePlugins` が理由に出る）
- 統合: 一時ワークスペース + `captureStderr`（`test/utils/test_logBackgroundError.ts` と同じ手）で、
  - 壊れたファイルの**名前と理由**が warn に出る
  - 壊れたファイルの隣の妥当な role は**そのまま読める**（握り潰しの意図は保つ）
  - 読めないエントリ（`*.json` という名前のディレクトリ）— errno はプラットフォーム差があるので理由文だけを assert する
  - readdir と read が食い違うケース = **dangling symlink**。先に消すと readdir に載らないのでこの分岐に入らない（win32 は symlink 権限のため skip）
  - `config/roles` が無い / 空のときは**何も出ない**（新規インストールが無音であること）
  - `.md` を置くと「`.json` のみ」の警告が出る / `.DS_Store` では出ない
