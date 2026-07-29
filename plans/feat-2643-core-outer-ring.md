# feat(remote-host): ホストランナーの外側リングを core に入れる (#2643)

## 背景

remote-host の回復機構は二重のリングになっている。

- **内側** — core の `startHostRunner`。同一ランナー内でリスナを張り直し、presence の ACK を監視し、`LISTEN_RETRY_WINDOW_MS`（5 分）を使い切ったら `onClosed` を呼んで止まる。
- **外側** — ランナーごと作り直す層。`resilientRunner` + `presenceProbe`。**core に無く、両ホストが各自のコピーを持っていた。**

| | MulmoClaude | MulmoTerminal |
|---|---|---|
| `resilientRunner.ts` | `server/remoteHost/` | `server/backends/remoteHost/` |
| `presenceProbe.ts` | `server/remoteHost/` | `server/backends/remoteHost/` |

## なぜ core に入れるか

外側リングの正しさが **core の内部定数に依存している**。core を上げるとホスト側のコピーが黙って壊れる。実際に起きた:

MulmoTerminal のコピーは settle ウィンドウ（60s）を生き延びただけで無条件に `markRecovered` する。

| core | listener を諦めるまで | 結果 |
|---|---|---|
| 1.8.0 | `attempt >= 5` → 約 31 秒 | settle より先に close → 障害クロックが積算され `giveUp` が発火 |
| 1.9.0 | `LISTEN_RETRY_WINDOW_MS` → 5 分 | 60 秒で先に `markRecovered` → クロックが毎回リセット |

1.9.0 では `GIVE_UP_MS`（5 分）に構造的に到達できず、`giveUp` が一度も発火しない。`onClosed` がライフサイクルに届かないので、**クライアントは再認証を促されない** — 死んだ資格情報を直す唯一の経路が塞がる。

MulmoClaude 側は #2637 でこの一点だけ直してある（settle でプローブに聞き、`alive === false` ならクロックを消さない）。つまり片方のコピーだけが修正を知っている状態で core が上がった。同じことは今後どちらの向きにも起きる。

## 決めたこと

1. **`RunnerHealth` はブラウザ安全な `@mulmoclaude/core/remote-host` に置く。**
   状態名（`online` / `reconnecting` / `offline`）と型ガードだけ。UI 文言は各ホストの i18n に残す。クライアントが HTTP ペイロードを narrow する必要があるため server 側ではなく protocol 側。
2. **`presenceProbe` も core に入れる。** `presenceStaleAfterMs()` が既に core にあり、しきい値の二重定義を消せる。`firebase/firestore` は core の peerDependency なので依存も増えない。
3. **`onHealth` は optional。** MulmoTerminal はツールバー表示に使う、MulmoClaude は今は使わない。必須にすると MulmoClaude 側に空実装を強いる。
4. **マージ元は MulmoClaude のコピー。** #2637 の settle 修正、`CHANNEL_METHODS` フィルタ（ハンドラのエラーをチャネルの障害として記憶しない）、クロージャ式のタイマーシーム（`CancelTimer`）を持っている方が新しい。ここに MulmoTerminal の `onHealth` / 初期状態のアナウンス / relaunch 時の重複アナウンス抑止を足す。
5. **移行はホストごと。** core 版を追加し、MulmoClaude は同 PR で乗り換える（workspace リンクなので即座）。MulmoTerminal は core を上げたときに乗り換える（receptron/mulmoterminal#1064）。この PR は MulmoTerminal のコピーを消さない。

## 変更

### core（追加）

- `packages/core/src/remote-host/health.ts` — `RUNNER_HEALTH_STATES` / `RunnerHealthState` / `RunnerHealth` / `isRunnerHealthState` / `isRunnerHealth`。`remote-host/index.ts` から re-export
- `packages/core/src/remote-host/server/presenceProbe.ts` — `createPresenceProbe` / `presenceIsFresh` / `withTimeout` / `PRESENCE_STALE_MS` / `Liveness`
- `packages/core/src/remote-host/server/resilientRunner.ts` — `startResilientHostRunner` / `reconnectDelayMs` / `ResilientHostRunnerDeps` / `CancelTimer`
- `remote-host/server/index.ts` から export（新しい subpath は増やさない）

### MulmoClaude（乗り換え）

- `server/remoteHost/resilientRunner.ts` / `presenceProbe.ts` を削除
- `server/remoteHost/index.ts` は core から import
- `test/remoteHost/test_resilientRunner.ts` / `test_presenceProbe.ts` を `packages/core/test/remote-host/` へ移設し、`onHealth` のテストを追加

### 出さないもの

- バージョン bump は別 commit（`chore(release)`）。この PR は core の `version` を触らない
- MulmoTerminal 側の変更（別リポジトリ、別 issue）

## 確認

- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build`
- `yarn test`（host）と core の `yarn test`
