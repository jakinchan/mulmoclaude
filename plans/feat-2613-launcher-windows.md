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
| 1 | PATH | launchd が PATH を落とすのでログインシェル hop が必須だった | Explorer 起動はユーザ環境変数の PATH を継承する見込み。nvm-windows / fnm / volta はユーザ環境変数に書くので **hop 自体が要らない可能性が高い** → spike で確定 |
| 2 | 生成物 | `.app` はただのディレクトリなので自作できた | `.lnk` はバイナリ形式で手書き困難。PowerShell の `WScript.Shell` COM で作る（ネイティブ依存なし） |
| 3 | コンソール窓 | 無縁 | `.cmd` を直接叩くと黒い窓が残る。`wscript.exe` + `.vbs` の `Run(cmd, 0, False)` で隠す |
| 4 | アイコン | `iconutil` で `.icns`（mac 専用コマンド） | `.ico` を自前で組む。Vista 以降 PNG 埋め込み ICO が使えるので、sharp が吐く PNG + ヘッダで生成できるはず → spike |
| 5 | node 不在ダイアログ | `osascript` の `display alert`（`nodejs.org` ボタン付き） | VBScript の `MsgBox`。追加依存なしで最速。戻り値でブラウザを開けるかは spike |
| 6 | 実行の警告 | ローカル生成物は quarantine 属性が付かない → Gatekeeper は出ない | 同じ理屈で Mark-of-the-Web が付かない → SmartScreen も出ない見込み → spike |
| 7 | ロケール | `defaults read -g AppleLocale`（`ja_JP` / `zh-Hans_US`） | node 側は `Intl` で足りる。**node 不在時のダイアログだけ** VBScript の `GetLocale()` が返す LCID（数値）を言語に落とす必要がある |

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

`windows-latest` の CI に spike 用ワークフローを一時的に置いて、次を測る:

1. **`.lnk` 生成** — PowerShell COM で作った `.lnk` が、`wscript.exe` + 引数付きで正しく起動するか
2. **`.ico`** — PNG 埋め込み ICO を自前で組んで、少なくとも Windows のイメージ API が読めるか
3. **detach** — `.vbs` から `Run(..., 0, False)` で node を起動し、**親が終了してもサーバが生き残るか**
   （PR1 では「子の stdout をパイプで受けると親が終了しない」という逆向きの事故があった）
4. **PATH の見え方** — `where node` / `where npx` が CI の環境で何を返すか
   （CI は nvm-windows 環境ではないので、**版管理ツール下の挙動は手動チェックリスト送り**。ここは CI で埋まらないと明示する）
5. **`GetLocale()`** — 実際に返る LCID 値と、日本語環境での見え方

spike が終わったらワークフローは消す（PR1 と同じく、結果だけ plan に残す）。

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

1. [ ] spike ワークフローを `windows-latest` に投げて 1〜5 を測る
2. [ ] 結果をこの plan に追記（否定された仮説はそのまま残す — PR1 の `zsh -lc` のように）
3. [ ] `windows/` 実装（`create-shortcut` の分岐、`.ico`、`.vbs`、`.lnk`）
4. [ ] テスト（純関数 → windows CI 統合）
5. [ ] `docs/manual-testing.md` §12、README / `packages/mulmoclaude/README.md` の Quick Start
6. [ ] PR。**実機での確認は依頼側にはできない**ので、何が未検証かを PR 本文に明記する

## 未解決（実装前に決める）

- `.lnk` をどこに置くか（デスクトップだけ / スタートメニューだけ / 両方）
- ランチャー本体の置き場所（`%LOCALAPPDATA%` か `%APPDATA%` か）
- node 不在ダイアログで `nodejs.org` をどう渡すか（`MsgBox` はボタン文言を変えられないので、本文に URL を書くか、OK 押下でブラウザを開くか）
