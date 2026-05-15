# docs: ffmpeg prerequisite + setup-mulmoclaude dependency check

Tracks: [#1049](https://github.com/receptron/mulmoclaude/issues/1049) — 依存欠落 UX 整備 umbrella。

## Umbrella 全体像 (#1049)

`#1049` のコメントで整理された PR 分割に、レビューア提案 (Slack `#1367`) を反映。**この plan は umbrella 全体を一覧したうえで、現時点の実装対象スライス (= 下表で ✅ / 🟡 がついた行) の詳細も併記する。**

### 設計原則 (レビューア提案)

> **「無ければ落ちる / エラー」ではなく「無いことが分かって、無くても動く」を目指す**。依存欠落時は該当 feature を **runtime で自動 disable** し、warn を出して残りの機能で起動する。fail-hard でなく fail-soft。

この原則は umbrella の全 PR に効く方針なので、新規行 PR-4 で「汎用フレーム」を立てつつ、既存 PR-1c / PR-2 / PR-3 の motivation も update する。

### PR 一覧

> **進捗管理ルール**: この `plans/docs-ffmpeg-prereq.md` を `#1049` umbrella の進捗ハブとして扱う。
>
> umbrella の各 PR に着手する際は、以下の手順で下表を更新する:
>
> 1. その PR 用の plan ファイルを `plans/<branch-name>.md` (例: `plans/feat-pr-4a-docker-auto-fallback.md`) に新規作成する
> 2. **下表の該当行の「状態」列に plan ファイルへの相対リンクを追記する** (例: `⏳ [plan](feat-pr-4a-docker-auto-fallback.md)`)
> 3. PR が立ったら同じセルに PR 番号も追記 (例: `🚧 [plan](feat-pr-4a-docker-auto-fallback.md) / #1380`)
> 4. PR がマージされたら `✅ #1380` に書き換え、対応する plan を `plans/done/` に移動 (`/archive-shipped-plans` skill で自動化)
>
> 表の更新を怠ると umbrella 全体の進捗が見えなくなる。新規 plan を作成したら、対応する行を必ず更新すること。

凡例: ✅ 完了 / 🟡 一部完了 / 🚧 進行中 / ⏳ 未着手

| ID        | 内容                                                                                                                                                                               | 状態                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **PR-A**  | README に Prerequisites を明記 (ffmpeg / Docker / claude CLI / Node)                                                                                                               | ✅ [plan](docs-ffmpeg-prereq.md) / #1367                                                      |
| **PR-1a** | bundled system skill の配布機構 (`--plugin-dir` + `discoverSkills` 拡張)                                                                                                           | ⏳                                                                                            |
| **PR-1b** | `/check-prereqs` skill — **対話的な依存チェック**。probe → 「入れる/後で/入れない」分岐 → install ガイド → 再確認。下記 PR-1b ノート参照                                           | ⏳ — PR-1a 依存                                                                               |
| **PR-1c** | Settings タブの依存欠落表示 (Gemini タブ横展開)。**Gemini API key 等の「あったら便利系」も案内**                                                                                   | ⏳                                                                                            |
| **PR-1d** | `npx` 利用者向けブラウザ onboarding                                                                                                                                                | ⏳                                                                                            |
| **PR-1e** | `yarn dev` 開発者向け onboarding skill                                                                                                                                             | 🟡 [plan](docs-ffmpeg-prereq.md) / #1367 (`setup-mulmoclaude` の dependency check 拡張で先行) |
| **PR-2**  | 各失敗経路 (動画 / PDF / 画像 / MCP / ブリッジ / scheduler) の Web UI 表面化 audit。**自動 disable と組み合わせて運用**                                                            | ⏳                                                                                            |
| **PR-3**  | `UserFacingError` 型導入 (`message` / `cause` / `remediation` / `docsUrl`)。**Disabled feature の理由表示にも使用**                                                                | ⏳                                                                                            |
| **PR-4**  | **依存欠落時の graceful degradation (capability gating)** — 起動時に `which` 等で依存を probe し、不足時は該当 feature を runtime disable + warn。落とさない。下記 PR-4 ノート参照 | ⏳                                                                                            |

### PR-1b ノート (新 skill `/check-prereqs`)

「主要な依存を集めて事前確認 → 不足を対話で 1 件ずつ案内」する独立 skill。Codex cross-review で分割推奨 (#1367 デザイン相談、`/tmp/codex-cross-review-local-docs-ffmpeg-prereq/design-skill-split.md`):

- **発動経路 3 つ**: (1) ユーザーが直接呼ぶ pre-flight check、(2) `setup-mulmoclaude` の Step 3 から委譲、(3) PR-4 の bell 通知から「`/check-prereqs` 実行」誘導
- **対話フロー**: 各依存に対して `probe → 結果表示 → (不足時) 入れる/後で/入れない 分岐 → install コマンド案内 (README から取得) → 再確認 → 次の依存へ`
- **依存定義の所在**: 新 skill だけが「probe command / required-for / skippable rationale」を持つ。**インストールコマンドは README が SoT** という #1367 の原則は維持
- **`setup-mulmoclaude` Step 3 の縮約 (重要)**: 現在の dependency check 表は「`/check-prereqs` を呼ぶ」だけの thin handoff に書き換える。同じ表を 2 箇所に持たない (Codex 指摘の「mixed concerns 回避」)
- **mode 引数は不要**: skill 1 個 = 1 mode で十分。pre-flight 用途と setup フロー内呼び出しで挙動を変える必要は無い (どちらも同じ「対話的に依存を確認」が欲しい)
- **配布**: 開発者向けは project-local `.claude/skills/check-prereqs/` で OK。npx 利用者にも届かせる場合は PR-1a (bundled system skill 機構) が前提

### PR-4 ノート (新規)

レビューア提案を素直に展開した umbrella 行。以下を別 PR として個別に出すことを想定:

- **PR-4a — Docker 不在 → 自動 `DISABLE_SANDBOX` + warn**: 起動時に `which docker` / `docker info` を probe。不足なら sandbox 無し起動に fallback し、起動 banner / Settings で「Docker 無しで動作中」を案内
- **PR-4b — ffmpeg 不在 → mulmocast 関連 plugin を runtime disable + warn**: 動画系 tool を tool list から除外、UI で「動画生成は無効 (ffmpeg 未インストール)」と案内
- **PR-4c — Gemini API key 不在 → 画像生成系 plugin を runtime disable + 案内**: 既存の Settings → Gemini タブを「不足案内」モードで使う
- **PR-4d — 共通フレーム**: 依存 probe + feature toggle の汎用化。PR-4a–c の重複を吸収

PR-4d を最初に作るとブロッキングになるので、PR-4a / 4b / 4c を個別に出して共通点が見えてから 4d に切り出すのが現実的。

## PR-A + PR-1e 一部 の詳細 (現状 #1367 でカバー)

umbrella のうち、**PR-A の完成版 + PR-1e の最小版** だけを束ねて先出ししたスライス。配布機構 (PR-1a) に依存しないので、umbrella の他 PR を待たずにマージできる。

### Why this slice first

- ffmpeg 不在は **無言失敗** で、ユーザが原因に辿り着けない（issue 本文の症状）
- README と開発者向け skill の両方を直すと、`npx` 利用者と `yarn dev` 開発者の両経路をカバーできる
- インストール手順は **README を SoT** にして、skill 側は「何をチェックするか」だけ持つ ── 将来 puppeteer / playwright 等が増えても 1 行追加で済む
- 配布機構 (PR-1a) や typed error (PR-3) に依存しない最小スライス

### Changes

#### 1. README 8 ファイル (`README.md` + 7 localized) に `### Prerequisites` サブセクション

現状: Quick Start 直下の 1 行 blockquote（Node + Claude CLI のみ）。
変更: 独立したサブセクションに格上げし、ffmpeg / Docker を含めた依存リストを作る。英語版テンプレート:

```markdown
### Prerequisites

- **Node.js 20+** — runtime
- **[Claude Code CLI](https://claude.ai/code)** — installed and authenticated. Run `claude` once to complete OAuth
- **ffmpeg** — required for movie generation. Skip if you don't generate videos
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg`
- **Docker Desktop** (optional but recommended) — enables sandbox mode. See [Installing Docker Desktop](#installing-docker-desktop) below
```

Localized 7 本 (`ja / zh / ko / es / pt-BR / fr / de`) は同じ構造で各言語に翻訳。Docker install セクションへのアンカーは各言語版の見出しに合わせる（`ja` → `#docker-desktop-のインストール`、`zh` → `#安装-docker-desktop`、`ko` → `#docker-desktop-설치`、`es` → `#cómo-instalar-docker-desktop`、`pt-BR` → `#instalando-o-docker-desktop`、`fr` → `#installer-docker-desktop`、`de` → `#docker-desktop-installieren`）。

#### 2. `.claude/skills/setup-mulmoclaude/` — 新規追加 (dependency check 付き)

未コミットだったので、ffmpeg + claude 認証チェックを含めた完成形を **新規 add**。

- `SKILL.md` Step 3 を **Dependency check** に拡張（`claude` CLI 認証 / Docker / ffmpeg を表で持つ）
- **インストールコマンドは持たない** — 不足時は README の `### Prerequisites` を参照させる（SoT 一本化）
- Pitfall 表に「Movie generation hangs / silently fails → ffmpeg missing」を追加
- `NOTES.ja.md` を SKILL.md と 1:1 で日本語訳

## Verification (PR-A + PR-1e 一部 / #1367)

- [x] `yarn format` / `yarn lint` / `yarn build` がパス
- [x] Codex cross-review 2 iteration で LGTM convergence
- [x] localized README 7 本の Docker アンカーが各々の実在見出しに解決することを確認
- [x] README の Quick Start を上から読んで自然に流れる
- [ ] (manual) `/setup-mulmoclaude` を ffmpeg 未インストール環境で実行し、README Prerequisites への誘導が機能する
- [x] PR description に User Prompt + Summary + Items to Confirm を最上部に配置
