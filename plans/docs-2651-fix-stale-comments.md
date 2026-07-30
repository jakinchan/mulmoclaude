# 実装に追随していないコメント 3 件を直す

Issue: #2651 · 関連: #1570 (token path を env 対応にした PR), #2653 (proxy port 固定を解消した PR, `d1f126900` でマージ済み)

## 直すもの

### 1. `e2e-live/fixtures/isolated-dev-server.ts:21-23` — バイパスの理由が 2 件とも古い

```text
// is bypassed entirely — Vite's proxy is hardcoded to 3001 and its
// token file path is hardcoded to `~/mulmoclaude/.session-token`,
```

- **token path**: #1570 で解消済み。`vite.config.ts:19-30` の `resolveWorkspacePath()` が
  `MULMOCLAUDE_WORKSPACE_PATH` を process.env と `.env` の両方から読む。
  `e2e-live/tests/fresh-boot.spec.ts:71` が「`.session-token` は temp workspace 側に書かれる」を
  実際に assert している。
- **proxy 3001 固定**: **#2653 (`d1f126900`) で既に解消済み** — `vite.config.ts` は
  `scripts/lib/devServerPort.ts` の `resolveServerPort()` からポートを取る。この plan を書いた
  時点では #2653 は open だったが、本 PR を開く前にマージされたので、コメントを
  「理由 = proxy port 固定」に絞る書き方は**もう事実ではない**。

→ 理由を「Vite の現在の実装上の制約」ではなく、**#2653 の前後どちらでも真な事実**で書く
   (陳腐化しない理由を選ぶ):
   テストごとに単一プロセスで完結すること、live test が published package と同じ
   static serving path を通ること。これは #2653 が `docs/developer.md` に書いた説明と同じ立場。

### 2. `e2e-live/fixtures/isolated-dev-server.ts:25` — `(added in this PR)`

指している PR は既にマージ済み (L-FRESH-BOOT)。読んだ人に「未導入の機能」と誤解させる。
CLAUDE.md の「コメントに現在のタスク・修正・呼び出し元を書かない」にも反する。
→ 削除し、env var が何をするかの説明だけ残す。

### 3. `server/agent/prompt.ts:105` — `workspacePath="/workspace"` が誤り (issue コメントの追加分)

コンテナ内の workspace は `/home/node/mulmoclaude`:

- `server/agent/config.ts:20` — `export const CONTAINER_WORKSPACE_PATH = "/home/node/mulmoclaude";`
- `server/agent/index.ts:132` — `workspacePath: useDocker ? CONTAINER_WORKSPACE_PATH : workspacePath`

`/workspace` はリポジトリ内でこのコメントにしか存在しない (同じ誤りが `docs/wiki-html-render-surfaces.md`
にもあったが #2652 で修正済み)。コメントの**主張自体**は正しく、誤っているのは例示したパスだけ。
→ 定数名を指す形に直す。

## やらないこと

- **e2e-live を Vite 経路に戻す**。#2653 後は技術的に可能になるが、live test の配線変更は別リスク
  (#2653 自身も対象外としている)。今回はコメントを事実に合わせるだけ。
- コメント内の他の issue 番号 (`#1070` / `#1029` / `#1432` / `#1280`) の整理。既存の履歴マーカーで、
  本 issue の範囲外。

## 検証

コード変更なし (コメントのみ) なので、根拠は grep と既存 test の assert に置く:

- `.session-token` が override 側に書かれること → `e2e-live/tests/fresh-boot.spec.ts:71` の既存 assert
- `/workspace` が他に無いこと → `grep -rn '"/workspace"'` が prompt.ts の 1 件のみ
- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build` / `yarn test`
