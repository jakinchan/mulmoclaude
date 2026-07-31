# ブローカーのコールドブートを削る — 方式選定と実測

Issue: #2235（#2201 のフォローアップ③）· 前提: #2233（実測、PR #2668 で完了）

## 選定結果: **方式1（ブローカーの事前ビルド）**

#2235 が挙げていた 2 案を実測で比較した。

| | ローカル TTFB（`initialize` 応答まで） |
|---|---|
| 現状（`tsx server/agent/mcp-server.ts`） | 4,036 / 6,743 ms |
| **事前ビルド（`node server/build/mcp-server.mjs`）** | **427 / 432 ms** |

**約 10〜15 倍速い。** 読むファイルが **292 → 1** になる（下記）。#2233 の実測で
「cold と warm に有意差なし＝毎回必ず払う仕事」と分かっているので、この削減はそのまま効く。

## 方式2（遅延 import）を選ばなかった理由 — 天井が低い

「express が import グラフに居る」という表層の観察からは方式2 が有望に見えるが、
**実行時の**依存グラフを取ると効果が小さいことが分かる。

計測方法: ESM の `resolve` フックで親子エッジを記録し、実際に解決されたファイルだけを数えた
（esbuild の metafile は `import type` を含むので**実行時の実態と大きく食い違う** — 実際
`spawnBackgroundChat.ts` → `api/routes/agent.ts` は型のみの import で、metafile 上は
1843 ファイルに見えるが実行時には 1 ファイルも読まれない）。

実行時 292 ファイル。トップレベル import ごとの「到達数 / そこだけから到達する数（排他）」:

| import | 到達 | 排他 |
|---|---|---|
| `server/agent/plugin-names.ts` | 198 | **85** |
| `server/agent/mcp-tools/index.ts` | 164 | **26** |
| `server/plugins/preset-loader.ts` | 159 | 2 |
| `server/plugins/dev-loader.ts` | 157 | 0 |
| `server/plugins/runtime-loader.ts` | 156 | 0 |

つまり大半（約 150 ファイル）は**複数の経路から共有されている中核**で、個々の import を
遅延化しても消えない。`mcp-tools/index.ts` を丸ごと切っても **26 ファイル**しか減らない。

対して方式1 は 292 ファイル全部（＋ ESM フックでは数えられない CJS の require ツリー）を
1 ファイルに畳む。**上限が違う。**

### 方式2 が無意味という意味ではない

`mcp-tools/index.ts` が `express` の `Router` を value import しているのは事実で
（ブローカーは HTTP ルーターを使わないのに読み込む）、ツールの**メタデータと実装が同じ
オブジェクトに同居している**構造的な問題は残る。ただし #2235 のゴール（起動時間）に対しては
費用対効果が低いので、別途整理する。

## 実装メモ（プロトタイプで確認済み）

esbuild で `server/agent/mcp-server.ts` を単一 ESM に束ねる。前例は
`scripts/build-hooks.mjs`（`server/workspace/hooks/dispatcher.ts` → `server/build/dispatcher.mjs`）。

確認できた注意点:

1. **`@duckdb/*` は external 必須** — ネイティブバインディング（`.node`）は束ねられない。
2. **`createRequire` の banner が必要** — express / body-parser / debug などの CJS 依存が
   `require("tty")` を動的に呼ぶため、ESM 出力では esbuild の `__require` shim が落ちる。
   ```js
   banner: { js: "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);" }
   ```
3. **出力位置が意味を持つ** — バンドルを `/tmp` に置くとプリセットプラグインの解決に失敗する
   （`preset package not resolvable`, 5 本中 0 本）。`server/build/` に置けば親ディレクトリ探索が
   リポジトリの `node_modules` に届き **5/5 成功**。実行時プラグインの動的 import も 3/3 成功。
   → バンドルはリポジトリツリー内に置くこと。
4. **サイズ 12 MB** — `build-hooks` の前例（11 KB）と違い git にコミットすると肥大するので、
   ビルド時生成 + gitignore にする。バンドルが無い場合は現状の `tsx` にフォールバックさせ、
   ビルド前の dev フローを壊さない。

## 残っている作業

1. `scripts/build-mcp-broker.mjs` を追加し `yarn build` に繋ぐ
2. `buildMulmoclaudeServer`（`server/agent/config.ts`）がバンドルを優先し、無ければ `tsx` に落ちる
3. Docker のマウントと npm launcher の `files` にバンドルが含まれることの確認
4. **#2233 のハーネスで Windows bind mount 上の before/after を測る** — ローカル（macOS ネイティブ）
   の 10〜15 倍がそのまま出るとは限らない。目標は #2235 記載の「CLI 既定の接続待ち（5 秒）内」
5. 束ねたブローカーの handshake が現行と同一の tools/list を返すことのテスト

## 検証済み

- バンドルは presets 5/5・runtime plugins 3/3 をロードし、`tsx` と同じく handshake に応答する
- TTFB 427/432 ms（`tsx` は 4,036/6,743 ms）
- 実行時グラフの計測は ESM `resolve` フックによる実測（metafile の静的推定ではない）
