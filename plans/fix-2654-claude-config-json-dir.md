# `claudeConfigJson()` に `CLAUDE_CONFIG_DIR` を追随させる

Issue: #2654 · 関連: #87 §2 (`CLAUDE_CONFIG_DIR` / `CLAUDE_CONFIG_JSON` を導入した issue)

## 何が壊れているか

`server/utils/claudeConfigPath.ts` の 2 つの helper が、**同じ env var に対して別々の場所を指す**。

| helper | `CLAUDE_CONFIG_DIR=/x` のとき | 実際の Claude Code |
|---|---|---|
| `claudeConfigDir()` | `/x` | `/x` ✅ |
| `claudeConfigJson()` | `<home>/.claude.json` | `/x/.claude.json` ❌ |

`CLAUDE_CONFIG_DIR` だけを設定したユーザーは、`~/.claude.json` に何も無いので:

- `server/system/docker.ts:21` — サンドボックス pre-flight が実在しないファイルを見て誤判定する
- `server/agent/config.ts:819` — Docker の `-v` が存在しないパスを渡す。Docker はソースが無いと
  **そこに空ディレクトリを作る**ので、コンテナ内の Claude CLI は設定なしで起動し、エラーも出ない

## 実挙動の確認 (external ground truth)

推測ではなく `claude` CLI 自身に確認した。CLI が書き込み先を明示的に print する:

```console
$ export CLAUDE_CONFIG_DIR=$(mktemp -d)
$ claude mcp add probe-server -- echo hi
Added stdio MCP server probe-server with command: echo hi to local config
File modified: /var/folders/.../tmp.Q7DA6eO4o3/.claude.json   # ← ここ
$ grep -c probe-server "$HOME/.claude.json"
0                                                              # ← home 側は無変更
$ claude mcp list | grep probe-server
probe-server: echo hi - ...                                    # ← 同じ env で読み戻せる
$ env -u CLAUDE_CONFIG_DIR claude mcp list | grep -c probe-server
0                                                              # ← env なしでは見えない
```

`.claude.json` は `CLAUDE_CONFIG_DIR` に**追随する**。書き込みだけでなく読み出しもその場所。
公式ドキュメント (https://code.claude.com/docs/en/settings) は `~/.claude.json` とだけ書いており
`CLAUDE_CONFIG_DIR` との関係に触れていないので、上記が唯一の根拠になる。

同じ contract を `receptron/mulmoterminal` の `server/infra/gui-mcp-registration.ts` が既に
正しく実装している (`path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || homedir(), ".claude.json")`)。
2 ホストで実装が矛盾しており、実測では MulmoTerminal 側が正しかった。

## 直すもの

### 1. `claudeConfigJson()` が `CLAUDE_CONFIG_DIR` を見る

優先順位は **`CLAUDE_CONFIG_JSON` > `<CLAUDE_CONFIG_DIR>/.claude.json` > `<home>/.claude.json`**。
`CLAUDE_CONFIG_JSON` は MulmoClaude 独自の脱出口なので、明示された値が最優先で変わらない。
どちらの env も未設定なら既定の挙動 (`<home>/.claude.json`) は不変。

第 3 引数 `dirOverride`（既定値 `env.claudeConfigDir`）を追加する。既存の `override` 引数と
同じ作りなので、テストは subprocess を立てずに env-set 分岐を突ける。

### 2. 空白だけの override を「未設定」として扱う

`join("", ".claude.json")` は `".claude.json"` — **相対パス**になる。これが Docker の `-v` の
左辺に入ると、cwd 依存の場所をマウントする。`??` は `""` を通してしまうので、
`CLAUDE_CONFIG_DIR=""` / `CLAUDE_CONFIG_DIR="  "` を `undefined` に正規化してから判定する。

MulmoTerminal 側が `?.trim() ||` で同じ扱いをしており、issue が正しい実装として挙げた側と
振る舞いを揃える。`claudeConfigDir()` にも同じ正規化を通すので、2 つの helper が
「空白は未設定」で一致する（今日は `claudeConfigDir("")` が `""` を返す）。

## やらないこと

- **`packages/core/assets/helps/error-recovery.md` への追記**。旧挙動で Docker が
  `~/.claude.json` の位置に作ってしまった空ディレクトリの掃除手順は書く価値があるが、
  `assets/helps/*` の変更は `@mulmoclaude/core` の bump + launcher の dep range 掃きを伴う
  (core 1.10.0 は npm 最新と一致)。リリース操作をこの PR に混ぜない。必要なら別 PR。
- **`CLAUDE_CONFIG_JSON` の廃止**。`CLAUDE_CONFIG_DIR` があれば大抵は不要になるが、
  ファイル単位で差し替えたいケース (テスト fixture, corp redirect) が残る。互換のため据え置き。
- **相対パスの拒否**。`CLAUDE_CONFIG_DIR=./foo` は今日も `claudeConfigDir()` を通って
  そのまま返る。空白の正規化とは別の話で、本 issue の範囲外。

## 検証

- `test/utils/test_claudeConfigPath.ts` に追加:
  - `CLAUDE_CONFIG_DIR` だけ set → `<dir>/.claude.json`
  - `CLAUDE_CONFIG_JSON` と `CLAUDE_CONFIG_DIR` 両方 set → `CLAUDE_CONFIG_JSON` が勝つ
  - どちらも未設定 → `<home>/.claude.json` (既定の挙動が変わっていないこと)
  - 空白だけの override → 未設定として扱われ、相対パスにならないこと
  - `claudeConfigDir()` / `claudeCredentialsPath()` / `claudeSkillsDir()` の空白扱い
- `test/agent/test_agent_config.ts` に追加: `CLAUDE_CONFIG_DIR` 相当を渡したとき
  Docker の `-v` の両方 (`.claude` と `.claude.json`) が**同じディレクトリ配下**を指すこと。
  helper 単体のテストでは「2 つのマウントが食い違わない」という本 issue の核心を assert できない。
- 修正を revert するとこの新テストが red になることを確認する (green の証明力を担保)。
- `docs/developer.md` の env 表 (`CLAUDE_CONFIG_DIR` / `CLAUDE_CONFIG_JSON` の行) を実挙動に合わせる。
- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build` / `yarn test`
