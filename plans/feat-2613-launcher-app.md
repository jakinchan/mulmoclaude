# feat(#2613): アイコンから起動する — mac `.app` / Windows `.lnk`

`npx mulmoclaude@latest` をターミナルで叩く代わりに、アイコンをクリックして起動できるようにする。
Electron は使わず、CLI を叩くランチャーを生成する。

> **このアプリを触る人にとって、ここが MulmoClaude の最初の画面になる。**
> ターミナルを開かない人が対象なので、失敗したときに何も言わずに終わるのが最悪の体験。
> 機能の少なさより、失敗時の丁寧さを優先する。（issue #2613 より）

## スコープ分割

| PR | 中身 | 検証 |
|---|---|---|
| **PR1（本 plan）** | 共通コア + mac `.app` + `mulmoclaude create-shortcut` | ローカル実機で全経路 |
| **PR2（別 plan）** | Windows `.cmd` / `.vbs` / `.lnk` 生成 | `windows-latest` CI + 実機手動チェックリスト |

OS ごとに独立実装すると、**チェック順序とメッセージ文面が二重化して片方だけ直る**事故になる。
issue が最優先と書いている「丁寧さ」の中身は OS 非依存なので、そこは 1 か所に置き、
OS 別なのは (a) PATH の解き方 (b) 生成物の作り方 (c) ネイティブダイアログの出し方 の 3 つだけにする。

---

## spike 結果（2026-07-27 実測 / macOS 26.5・nodebrew 環境）

実装前に 4 つの未検証点を潰した。**issue に書かれた対策案のうち 1 つは実測で否定された。**

### 1. `zsh -lc` は誤り — `-l -i -c` でなければならない

issue の対策候補 1（`exec /bin/zsh -lc '...'`）をこのマシンで実測した結果:

| 方式 | 解決された node | claude | 所要 |
|---|---|---|---|
| 裸の GUI PATH | NOT-FOUND | NOT-FOUND | — |
| `zsh -l -c`（login のみ） | `/opt/homebrew/bin/node` = **v26.3.0** | **NOT-FOUND** | 85ms |
| `zsh -l -i -c`（login + interactive） | `~/.nodebrew/current/bin/node` = **v24.12.0** | `~/.local/bin/claude` | 454ms |

**`-l` だけでは駄目な理由**: nodebrew / nvm / asdf などのバージョンマネージャと `~/.local/bin` の PATH 追加は
`.zshrc`（interactive 用 rc）で行われるのが普通で、非対話ログインシェルはこれを読まない。
結果として `-lc` は

- ユーザーが実際に使っているのとは**別バージョンの node** を掴む（v26.3.0 vs v24.12.0）
- **`claude` を見つけられない** → 「Claude Code をインストールしてください」と誤案内する

issue が「最悪」と書いた *「node が無い」と誤検出して初心者を追い返す* が、対策案 1 のままだと実際に起きる。

**採用**: ログインシェルは `dscl . -read $HOME UserShell` で引き（`$SHELL` は launchd 下では当てにならない）、
`"$USER_SHELL" -l -i -c`（フラグは分離。zsh/bash/fish いずれでも通る形）で **PATH 文字列そのもの**を回収して、
以降の子プロセス全部に渡す。node だけ解決しても `claude` が落ちるので、解決対象は PATH 全体。

### 2. rc ファイルの出力は汚れる → センチネル必須

`-i` を付けると `.zshrc` が動くので、stderr に
`Could not open a connection to your authentication agent.` のような雑音が出た（実測）。
stdout にバナーを出す rc も珍しくない。

**採用**: `__MC_PATH_BEGIN__` / `__MC_PATH_END__` で挟んで `sed` で抜き出す。stderr は捨てる。
バナー混入ケースを spike で再現し、マーカー方式で正しく抜けることを確認済み。

### 3. タイムアウトは POSIX sh の watchdog（perl `alarm` は**効かない**）

macOS に `timeout(1)` は無い。2 案を実測:

| 方式 | 正常時 | ハングした rc を切れるか |
|---|---|---|
| `perl -e 'alarm 3; exec @ARGV'` | 388ms | **切れない（60秒フル待ち）** |
| sh の background + kill watchdog | 407ms | **3022ms で切れる** ✓ |

perl 版が効かないのは、`exec` 後に SIGALRM が zsh を殺しても、zsh が産んだ子（`sleep`）が
コマンド置換のパイプを掴んだままだから。**同じ罠が sh 版の素朴な実装にもあり**、
watchdog サブシェルの stdout を `>/dev/null` に落とさないと、正常時でも
**毎回タイムアウト秒数ぶん（10秒）固定で待たされる**（実測 10s → 修正後 407ms）。

**採用**: sh watchdog + watchdog の stdout を明示的に切り離す。この 1 行を消すと 10 秒の遅延が戻るので、
理由をコメントに残す。

### 4. `launcher.html` の CORS — 生存検出は通る、正体判定は通らない

`file://` オリジンから 3 状態（401 を返す MulmoClaude / 404 を返す別アプリ / 誰もいない）へ
4 方式でプローブし、chromium と webkit（＝Safari エンジン。対象読者の既定ブラウザ）で実測:

| 方式 | 生きてる(401) | 別アプリ(404) | 閉じてる |
|---|---|---|---|
| `fetch(no-cors)` | resolved (opaque) | resolved (opaque) | **throw** |
| `fetch(cors)` | throw | throw | throw |
| `<img>` onload/onerror | onerror | onerror | onerror |

- **生存検出はできる**: `fetch(no-cors)` が resolve するか throw するかで「誰か居る / 居ない」が両エンジンで一致して判定できた。**CORS はブロッカーにならない。** Private Network Access のプロンプトも出なかった。
- **正体判定はできない**: 401 と 404 が両方 opaque になるので、ブラウザ側からは「MulmoClaude か別アプリか」を区別できない。
- `<img>` は全ケース onerror なので使えない。

**採用**: 役割を分ける。
- **ネイティブ側（.app のシェル → node）** が「再利用 or 新規起動」を決める。CORS 制約が無く、401 の中身もヘッダも読めるので `/api/health` で正体を判定できる。
- **`launcher.html`** は生存ポーリングと進行表示だけを担当し、生きたらリダイレクトする。

`file://` → `http://127.0.0.1:PORT` の script リダイレクトも両エンジンで通ることを確認済み（ここが塞がっていると
ローディング画面から先に進めなくなるので事前に確認した）。

### 5. `.app` 実機確認

`Info.plist` + `Contents/MacOS/launch`（シェルスクリプト）だけの最小バンドルを生成し、
`env -i ... open -n SpikeApp.app` で LaunchServices 経由で起動 = **Finder ダブルクリックと同一条件**
（`XPC_SERVICE_NAME` が付き、env 16 個、`PATH=/usr/bin:/bin:/usr/sbin:/sbin`）。

- 上記 1〜3 の方式で PATH を回収し、node v24.12.0 / npx / claude すべて解決できた
- 自前生成なので `com.apple.quarantine` は付かず、Gatekeeper の警告は出ない（`xattr` で確認。付くのは `com.apple.provenance` のみ）
- ターミナルから素の `open App.app` は親環境を継承してしまう（env 59 個・PATH 完全）ので、**検証には使えない**

---

## 起動フロー（確定版）

```
アイコンをクリック
  ↓
[shell] Contents/MacOS/launch — ここだけシェル。やることは 1 つだけ
  ├ dscl でログインシェルを引く
  ├ "$SHELL" -l -i -c でセンチネル付きで PATH を回収（watchdog 付き）
  ├ 失敗 → 既知の場所を走査（nodebrew/nvm/fnm/asdf/volta/homebrew/…）
  └ node が見つからない → osascript でネイティブ案内を出して終了
  ↓
[node] 以降は全部 JS（タイムアウト・ログ・GUI ダイアログが素直に書ける）
  ├ ① 既存サーバ検出 → MulmoClaude なら launcher.html を挟まずブラウザを開いて終了
  ├ ② 前提チェック（node バージョン / claude の有無）→ 欠けていれば GUI 案内
  ├ ③ launcher.html をブラウザで開く（進行表示）
  ├ ④ npx mulmoclaude@latest を spawn
  └ ⑤ launcher.html が生存を検出 → サーバへリダイレクト
       失敗 → launcher.html にエラー + 次の一手 + ログの場所
```

## 「既存サーバがあればブラウザを開くだけ」の実装

現状の launcher は 3001 が埋まっていたら **3002 にずらして 2 つ目を立てる**
（`packages/mulmoclaude/bin/mulmoclaude.js` の `chooseAvailablePort`）。issue の決定と逆なので、
ポートの占有者が MulmoClaude 自身かどうかを見分ける必要がある。

`/api/health`（`server/index.ts`）は `bearerAuth` の配下なので**認証なしだと 401** が返る。
`{status:"OK"}` は読めないが、判定には十分:

| 観測 | 判定 |
|---|---|
| `ECONNREFUSED` | 誰も居ない → 起動する |
| 401（MulmoClaude の認証応答） | MulmoClaude が居る → **ブラウザを開くだけ** |
| その他（404 等） | 別アプリが居る → 別ポートへ |

**この「401 を生存判定に使う」は意図的な設計**。認証の掛け忘れに見えるので、
消されないようコード側にも理由をコメントとして残す。

## 実装（PR1・完了）

置き場所は `server/utils/launcher/`。既存の `server/utils/*.mjs`（`port.mjs` / `launch-env.mjs` /
`cli-flags.mjs`）と同じ「ランチャーと共有する素の `.mjs` + 隣に `.d.mts`」の踏襲で、
`prepare-dist.js` が `server/` ごとパッケージにコピーするのでそのまま npm に載る。

| # | 内容 | ファイル |
|---|---|---|
| 1 | PATH 解決（shell hop + 走査フォールバック） | `macos/resolve-path.sh` |
| 2 | 8 言語メッセージカタログ | `messages.mjs` |
| 3 | 前提チェック（node バージョン / npx / claude） | `preflight.mjs` |
| 4 | 既存サーバ検出（401 判定） | `detect-server.mjs` |
| 5 | 進行ページ + エラーページ | `launcher-page.mjs` |
| 6 | node 側オーケストレータ | `start.mjs` / `run.mjs` |
| 7 | `.app` 生成・アイコン生成 | `macos/create-app.mjs` / `macos/icon.mjs` / `macos/launch.sh` |
| 8 | `create-shortcut` サブコマンド | `create-shortcut.mjs` + `bin/mulmoclaude.js` |
| 9 | テスト（66 件） | `test/utils/launcher/` |

1〜6 は OS 非依存。PR2 は 7 の隣に `windows/` を足すだけで済む。

### PATH 解決がシェル側にしかない理由

node を見つける前に走る必要があるので、この 1 ステップだけは他に置き場所がない。
代わりに **シェルスクリプト自体を `node:test` から実行して検証**している
（`test/utils/launcher/test_resolvePath.ts`）。フェイクのログインシェルを差し込んで、
`-l -i -c` で呼んでいること・バナー混入を弾くこと・ハングを切ること・
走査が `claude` だけのディレクトリを拾うことを、すべて剥がした環境下で当てている。

### 実装中に見つかって潰した事故

- **`npx` 不在が無言の失敗になる**: サーバは detach して spawn するので、`npx` が無くても
  誰も気付かない（進行ページが 120 秒回って終わる）。前提チェックに `npx` を足した。
  実装順は node バージョン → npx → claude。
- **ランチャーが終了しない**: 子の stdout/stderr をパイプで受けると、親がその読み口を
  掴んだまま生き続ける（detach したい意図と正反対）。ログの fd を直接 stdio に渡す形に変更。
  実測で「終了せずハング」→「即時終了・サーバは生存」に修正済み。
- **URL がリンクになっていなかった**: 案内文の `https://nodejs.org/` がただのテキストだった。
  `linkify()` を追加。CJK が直後に続いてもリンク境界が URL で止まることをテストで固定。
  ネイティブダイアログ（node が皆無で HTML を出せない唯一の経路）は
  `buttons {"OK", "nodejs.org"}` にして、押すと `open https://nodejs.org/` する。
  ボタン名が固有名詞なので翻訳不要。

## 検証済み（実機 macOS 26.5）

- `.app` を LaunchServices 経由で起動（`env -i … open -n`＝Finder ダブルクリックと同一条件）
  → nodebrew の node v24.12.0 / npx / claude をすべて解決
- 既存サーバあり（401）→ ブラウザを開くだけ。`npx` は spawn されない
- `claude` 不在 → エラーページ（コマンドがコピーできる形）
- 起動経路（`npx` をスタブ化）→ ポート選択・進行ページ・ポーリング・リダイレクト・
  ログ取り込みが通り、ランチャーは即終了、サーバは生存
- 進行ページ / エラーページを Chromium・WebKit で駆動（リダイレクト / 失敗表示 / 再試行）
- `prepare-dist` 後の実際の CLI（`mulmoclaude create-shortcut --dir … --yes`）で
  バンドル生成 → 同梱モジュールの相対 import が解決することまで確認

## 残タスク

- [ ] 実機でのダブルクリック・アイコン描画・ネイティブダイアログのボタン
      → `docs/manual-testing.md` §11（自動化不能なので手動チェックリスト化済み）
- [ ] PR2: Windows。`windows-latest` CI で生成物と起動を当て、
      Explorer ダブルクリック / アイコン / コンソール窓 / SmartScreen は手動に回す
- [ ] 起動したサーバの止め方（アイコンからは止められない）。issue のスコープ外だが、
      常駐の扱いを決めるときに一緒に考える

## spike の再現

`plans/` にはコードを置かないが、上記の測定は以下の形で再現できる:

- PATH: `env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin sh -c '/bin/zsh -l -c "command -v node"; /bin/zsh -l -i -c "command -v node"'`
- `.app`: 最小バンドルを作り `env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin open -n Foo.app`（素の `open` は親環境を継承するので不可）
- CORS: `file://` のページから 401 / 404 / 閉じたポートへ `fetch(url, {mode:"no-cors"})` を投げ、chromium と webkit で比較
