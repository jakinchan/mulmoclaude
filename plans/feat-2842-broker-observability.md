# feat(#2842): ブローカー起動を「外から見える」ようにする

#2842 のフィールド報告に対する対策。報告者は v1.8.0（#2235 のバンドル未収録）だったため、
まず本人にはバージョン更新を依頼済み。ここで直すのは **バージョンに関係なく残る観測性の穴**。

報告者は「イメージのビルド日」「CLI 2.1.220」「CLI バンドル内の `alwaysLoad` 出現回数」まで
自力で調べたうえで、それでも「tsx 経路に落ちている」という決定的な事実に到達できなかった。
これは調査能力ではなく、その事実がどこにも出力されていないことの問題。

## スコープ

| # | 何 | 触る場所 |
|---|---|---|
| ① | ブローカーが bundle 経路か tsx 経路かを spawn ログに出し、tsx なら warn | `server/agent/config.ts`, `server/agent/index.ts` |
| ⑤ | sandbox イメージ内の Claude CLI バージョンを記録・表示し、古ければ warn | `Dockerfile.sandbox`, `server/system/docker.ts` |
| ② | ブローカーがホストへ ready ビーコンを返し、コールドブート実測をホストログに出す | `server/agent/mcp-server.ts`, 新 route, `server/api/routes/agent.ts` |

やらないこと（#2842 の残り、別チケット）:

- **fail-fast**（60 秒天井を早期に打ち切る）。②の実測が無いまま閾値を決めるのは勘になる。②が前提。
- **replay ポリシーの経過時間依存化**。同上。

## ① bundle / tsx のどちらを選んだかを出す

`resolveBrokerCommand` は `existsSync(BUNDLED_MCP_SERVER_PATH)` の真偽だけで経路を決めるが、
どちらを選んだかを一切記録しない。`spawning agent` ログ（`server/agent/index.ts`）も
`backend / roleId / useDocker / hasMcp / resumed / hasSessionId` の 6 つだけ。

- `BrokerSpawn` に `kind: "bundle" | "tsx"` を足す（`brokerSpawn` は既に純粋関数 + テスト済み）。
- `resolveBrokerKind(useDocker)` を export し、`spawnLog.broker` に載せる。
- tsx を選んだときは **プロセスにつき 1 回だけ** warn。理由（バンドルが無い）と対処
  （`yarn build:mcp-broker` / パッケージ更新）まで書く。毎ターン出すとログが埋まる。

## ⑤ CLI バージョンを判明させる（ピンではなく）

現状 `Dockerfile.sandbox` は `npm install -g @anthropic-ai/claude-code`（未固定）で、
`ensureSandboxImage` は **Dockerfile の sha が変わったときだけ** 再ビルドする。
つまり Dockerfile が変わらない限りイメージ内の CLI は無期限に凍結される。

単純なピン留めはしない。`alwaysLoad` は CLI ≥ 2.1.121 を要求する＝新しい CLI 側に依存しており、
ピンは「更新のたびに Dockerfile を触る保守債務」と「古い CLI に据え置かれた利用者」を生む。

代わりに:

- `ARG CLAUDE_CODE_VERSION=latest` を導入し `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}` を入れる。
  再現目的で固定したい人は build-arg / env で指定できる。既定は今までどおり latest。
- ビルド時にホストが解決したバージョンを **イメージのラベル** に焼く
  (`mulmoclaude.claude-code.version`)。
- `ensureSandboxImage` が既に叩いている `docker image inspect` を 1 回で
  ラベル + `.Created` まで読む（コンテナは起動しない = 実行時コストゼロ）。
  - `log.info("sandbox", ...)` で CLI バージョンとイメージ齢を必ず出す。
  - CLI が我々の要求下限（2.1.121）未満、またはイメージが古すぎるときは `log.warn` +
    具体的な更新コマンド。
- 既存イメージにはラベルが無い（`inspect` が空を返す）。Dockerfile が変わる＝sha が変わるので
  全員が一度再ビルドされ、そこでラベルが付く。

## ② ready ビーコン（本番でコールドブートを測る）

ブローカーは自分の stderr にしか書かず、その stream は MCP 子プロセスの親である Claude CLI が
握っている。ホストの `server/system/logs/` には構造上届かない。だから外形上「遅い」と「死んでいる」が
完全に同一に見える（報告者の "no `prefix: \"mcp\"` broker line" は欠落ではなく仕様どおり）。

ブローカーには既にホストへ POST する経路（`postJson` + `AUTH_HEADER`）がある。これに相乗りする。

- 計測はホスト側の時計ではなく **ブローカー自身の `performance.timeOrigin` からの経過** で取る。
  コンテナとホストで時計を合わせる必要が無く、`timeOrigin` は node プロセス開始時刻なので
  「tsx の変換 / 6MB バンドルの読み込み」がそのまま数字に出る。これが測りたいコールドブートそのもの。
- `initialize` に応答した **直後**（`respond` の後、await しない）に 1 発だけ POST。
  失敗は stderr 1 行に握って握りつぶす。ハンドシェイクを絶対に遅らせない。
- 新 route `POST /api/mcp/broker-ready`（`hookLog.ts` と同じ形: bearer 認証・検証・204）。
  ホストは `log.info("mcp", "broker ready", { bootMs, initializeMs, broker })` を出し、
  閾値超えなら `log.warn`。
- セッションごとに ready を記録しておき、broker-not-ready リカバリの warn に
  `brokerEverReady` を載せる。これで「遅い」と「そもそも来ていない」がログだけで分かる。

## 検証

- `yarn format` → `yarn lint` → `yarn typecheck` → `yarn build` → `yarn test`
- 新規ユニットテスト:
  - `brokerSpawn` の `kind`（bundle / tsx × docker / native）
  - ビーコン route の検証（不正 body → 400、正常 → 204、閾値超えで warn）
  - CLI バージョン比較の純粋関数（下限未満 / 以上 / 不明）
- Docker が有効な環境で実際に 1 ターン回し、`broker` と `broker ready` の行が出ることを確認する
  （build が通ることは「動いた」の証拠にならない）。
