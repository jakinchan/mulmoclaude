# feat(#2613) PR2: Windows — アイコンから起動する

PR1（macOS `.app` / #2615 / `13efce4f2`）の続き。同じ入口を Windows にも作る。

> **このアプリを触る人にとって、ここが MulmoClaude の最初の画面になる。**
> 失敗したときに何も言わずに終わるのが最悪の体験。（issue #2613）

PR1 で決めた分割どおり、**OS 非依存の部分は 1 か所のまま**にして、OS 別に書くのは 3 つだけ:
(a) PATH の解き方 (b) 生成物の作り方 (c) ネイティブダイアログの出し方。

## そのまま再利用するもの（書き直さない）

`messages.mjs`（8 言語） / `preflight.mjs`（node → npx → claude） / `detect-server.mjs`（401 で自分を識別） /
`launcher-page.mjs`（進行ページ・エラーページ） / `start.mjs` / `run.mjs` / `port.mjs`。

ここを二重化すると **チェック順序とメッセージ文面が分岐して片方だけ直る**事故になる。
PR1 の plan がその理由で 1 か所に置いたので、PR2 は `macos/` の隣に `windows/` を足すだけにする。

---

## macOS と違うところ（設計の分岐点）

| # | 論点 | macOS でどうしたか | Windows |
|---|---|---|---|
| 1 | PATH | launchd が PATH を落とすのでログインシェル hop が必須だった | **実測で確定: hop は不要**。`.lnk` 経由の子が 73 エントリの PATH を継承し node を見つけた |
| 2 | 生成物 | `.app` はただのディレクトリなので自作できた | `.lnk` はバイナリ形式で手書き困難。PowerShell の `WScript.Shell` COM で作る（ネイティブ依存なし） |
| 3 | コンソール窓 | 無縁 | `.cmd` を直接叩くと黒い窓が残る。`wscript.exe` + `.vbs` の `Run(cmd, 0, False)` で隠す |
| 4 | アイコン | `iconutil` で `.icns`（mac 専用コマンド） | **実測で確定**: 自前で組んだ PNG 埋め込み ICO を Windows が読めた |
| 5 | node 不在ダイアログ | `osascript` の `display alert`（`nodejs.org` ボタン付き） | VBScript の `MsgBox`。追加依存なしで最速。戻り値でブラウザを開けるかは spike |
| 6 | 実行の警告 | ローカル生成物は quarantine 属性が付かない → Gatekeeper は出ない | Mark-of-the-Web が付かない → SmartScreen も出ない見込み。**CI では確認できない**（ダブルクリックの経路が要る）ので手動チェックリスト |
| 7 | ロケール | `defaults read -g AppleLocale`（`ja_JP` / `zh-Hans_US`） | **実測で確定**: `GetLocale()` は `1033` のような数値 LCID。node 不在時のダイアログだけ LCID → 言語のマップが要る |

### 7 について（PR1 の教訓をそのまま持ち込む）

PR1 で最後まで残ったバグは、まさにこのロケール解決だった（`zh-Hans_US` が英語に落ちる）。
Windows 側も **シェル/VBS 側と node 側で 2 実装になる**ので、同じ手を打つ:
LCID → 言語のマッピングは純関数として切り出し、
「VBS が選んだファイルの中身 == `pickLauncherLocale` + `renderNodeMissingText` の出力」を
全ロケールで固定するテストを最初から書く。

---

## 測れないものを測る（実装前の spike）

**開発機は macOS なので Windows の挙動は一切ローカルで確認できない。**
PR1 は 4 つの未検証点を実測で潰してから書き始め、そのうち 1 つ（issue の対策案 `zsh -lc`）は
**実測で否定された**。同じ手順を踏まないと、Windows では推測で書いたものがそのまま出荷される。

`windows-latest` の CI に spike 用ワークフローを一時的に置いて測った。**結果は下の「spike 結果」節**。
測ったのは次の 5 点:

1. **`.lnk` 生成** — PowerShell COM で作った `.lnk` が、`wscript.exe` + 引数付きで正しく起動するか
2. **`.ico`** — PNG 埋め込み ICO を自前で組んで、少なくとも Windows のイメージ API が読めるか
3. **detach** — `.vbs` から `Run(..., 0, False)` で node を起動し、**親が終了してもサーバが生き残るか**
   （PR1 では「子の stdout をパイプで受けると親が終了しない」という逆向きの事故があった）
4. **PATH の見え方** — `where node` / `where npx` が CI の環境で何を返すか
   （CI は nvm-windows 環境ではないので、**版管理ツール下の挙動は手動チェックリスト送り**。ここは CI で埋まらないと明示する）
5. **`GetLocale()`** — 実際に返る LCID 値と、日本語環境での見え方

spike が終わったらワークフローは消す（PR1 と同じく、結果だけ plan に残す）。

---

## spike 結果（2026-07-27 実測 / `windows-latest` runner・node 24.18.0）

**結論: macOS でいちばん厄介だった PATH が、Windows では問題にならない。** 5 点すべて肯定。

| # | 測ったこと | 結果 |
|---|---|---|
| 1 | `.lnk` → `wscript.exe` の子プロセスが見る PATH | **73 エントリを継承**。`C:\hostedtoolcache\...\node\24.18.0\x64` と `C:\Program Files\nodejs\` の両方が見えた → **ログインシェル hop は不要** |
| 2 | PowerShell `WScript.Shell` COM の `.lnk` | 生成 → 読み戻し（`TargetPath` / `Arguments` 一致）→ `Start-Process` で起動、子がマーカーを書いた。`lnk-run=OK` |
| 3 | 自前で組んだ PNG 埋め込み `.ico` | `System.Drawing.Icon` が読めた（`ico-read=OK` / `ToBitmap` も成功）。`.lnk` の `IconLocation` にも設定できた。ローカルでは `file` が `MS Windows icon resource - 6 icons ... PNG image data` と認識 |
| 4 | `.vbs` の `Run(cmd, 0, False)` で detach | 親 `wscript` 終了後も**子が書き続けた**。`detach=OK` |
| 5 | ネイティブダイアログの手段とロケール | `wscript.exe` / `mshta.exe` / `powershell.exe` すべて存在。`GetLocale()` は **1033**（数値 LCID）を返した |

### ここから決まること

- **PATH 復元シェルは Windows には要らない。** mac の `resolve-path.sh` に相当するものを書かない。
  ただし CI は版管理ツール（nvm-windows / fnm / volta）環境では**ない**ので、
  「版管理ツール下でも Explorer 起動が node を見つけるか」は CI では埋まらない → 手動チェックリスト送り。
- **`.ico` は自前生成でよい。** sharp が吐く PNG を ICO コンテナに詰めるだけ。
  （spike 中は sharp 抜きで PNG を作ったが、それは spike ジョブが `yarn install` をしないため。
  製品側は `macos/icon.mjs` と同じく sharp を使い、`iconutil` に当たる部分だけ自前で書く。）
- **ロケールは LCID → 言語のマップが要る。** `AppleLocale` のような文字列は返ってこない。
  PR1 のロケール事故（`zh-Hans_US` が英語に落ちた）と同じ構図なので、
  **マップは純関数に切り出し、VBS 側と node 側の答えが一致することをテストで固定する**。
- **detach 方式が確定。** `.vbs` の `Run(..., 0, False)`。コンソール窓も出ない。

---

## スコープ

**入れる**

- `mulmoclaude create-shortcut` が Windows でも動く（今は `process.platform !== "darwin"` で即エラー）
- 生成物: `%LOCALAPPDATA%\MulmoClaude\launcher\` にランチャー一式 + `.ico`、デスクトップとスタートメニューに `.lnk`
- 既存サーバの再利用・前提チェック・進行ページ・エラーページ・8 言語は PR1 の実装をそのまま通す
- node 不在時のネイティブダイアログ（Windows 版）
- `docs/manual-testing.md` §12 に Windows の手動チェックリスト（Explorer ダブルクリック / アイコン描画 / コンソール窓が出ないこと / SmartScreen）

**入れない**

- 署名 / インストーラ（PR1 と同じく「自分で生成したものは警告が出ない」に乗る）
- 自動更新（PR1 同様、アップグレード後は `create-shortcut` を叩き直す）
- #2616（UI からの終了）と #2617（リマインダー設定）— 別 issue

---

## テスト方針

PR1 と同じく、**OS 依存部分こそテストする**。

| 対象 | どこで |
|---|---|
| ICO ヘッダの組み立て、LCID → 言語、`.lnk` 生成コマンドの組み立て、インストール先の解決 | 純関数として切り出し、`node:test` で OS 非依存に（macOS の CI でも走る） |
| VBS のロケール選択 == node 側の選択 | mac の `test_messageFile.ts` と同じ形の対応テスト |
| 実際の `.lnk` / `.ico` / detach | `windows-latest` の CI（`lint_test (Windows)` が既にあるので、その隣に置く） |
| Explorer のダブルクリック / アイコン描画 / SmartScreen | **自動化不能** → `docs/manual-testing.md` §12 |

---

## 段取り

1. [x] spike ワークフローを `windows-latest` に投げて 1〜5 を測る
2. [x] 結果をこの plan に追記し、spike ワークフローを削除
3. [ ] `windows/` 実装（`create-shortcut` の分岐、`.ico`、`.vbs`、`.lnk`）
4. [ ] テスト（純関数 → windows CI 統合）
5. [ ] `docs/manual-testing.md` §12、README / `packages/mulmoclaude/README.md` の Quick Start
6. [ ] PR。**実機での確認は依頼側にはできない**ので、何が未検証かを PR 本文に明記する

## 未解決（実装前に決める）

- `.lnk` をどこに置くか（デスクトップだけ / スタートメニューだけ / 両方）
- ランチャー本体の置き場所（`%LOCALAPPDATA%` か `%APPDATA%` か）
- node 不在ダイアログで `nodejs.org` をどう渡すか（`MsgBox` はボタン文言を変えられないので、本文に URL を書くか、OK 押下でブラウザを開くか）
