# セッション選択のたびに全行が再描画される (#2809)

## 背景

セッション履歴パネル（左カラム）で行をクリックしてから画面が変わるまで、セッション数が
多い環境で 100〜300 ms かかり、その間フィードバックが一切ない。

#2809 の計測（セッション 808 件、Safari、典型値 約 170 ms）:

| 内訳 | 時間 |
| --- | --- |
| `GET /api/sessions/:id` | 7〜13 ms |
| セッション構築 | 0〜1 ms |
| `formatDate()` × 808 行 | 41〜50 ms |
| `t()` × 808 行 | 6〜8 ms |
| プレビュー解決 × 2424 回 | 1〜4 ms |
| Vue のパッチ + レイアウト/ペイント | 約 110 ms |

サーバ側は律速ではない。実際に見た目が変わるのは 2 行（選択が外れる行と付く行）だけで、
残りは同じ内容を作り直している。

## この PR でやること

#2809 の「考えられるアプローチ」1〜3 を 1 PR で入れる。4（仮想化）は入れない。

### 1. 行を子コンポーネントへ切り出す（案2、効果の主体）

`SessionHistoryPanel.vue` の `v-for` の中身を `SessionHistoryRow.vue` に移す。
親が再描画されても、Vue は props が `===` で変わっていない子の更新をスキップするため、
選択変更で実際に再描画されるのは `selected` が反転した 2 行だけになる。

props が安定していることが前提なので、次を守る:

- `session` — `mergedSessions` は live セッションだけ `buildLiveSummary` で新しい
  オブジェクトを作り、server-only 行は `sessions.value` の参照をそのまま流す
  （`mergeSessionLists`）。よって大半の行は参照が変わらない。
- `roles` — `App.vue` の `ref` をそのまま渡す。
- ハンドラ — v-for のループ変数を閉じ込めたインライン矢印関数を渡すと毎回新しい関数参照に
  なり、props 比較が必ず不一致になって子がスキップされない。**`@select="onRowSelect"` の
  ようにメソッド参照だけを渡し、対象は emit のペイロードで返す**。

### 2. 行ごとの日時整形・i18n 補間を computed にする（案1）

`formatDate()` / `t()` / プレビュー解決を子の `computed` にする。computed は依存
（`session.updatedAt` など）が変わらない限り再評価されないので、`selected` が変わって
子が再描画されても文字列整形は走らない。全行ぶんの `toLocale*`（Safari 41〜50 ms）が
クリック経路から消える。

### 3. クリック直後に選択状態を反映する（案3）

`useSessionLifecycle.ts` の `loadSession` は `await apiGet(...)` の後まで
`currentSessionId` を書かないため、選択枠がサーバ往復ぶん遅れる。fetch の**前**に
`currentSessionId` を進める。

URL は従来どおり成功後の `activateSession` で確定させる（router を先に動かさない）ので、
失敗時のロールバックは ref の巻き戻しだけで済む。

**失敗時の扱い**（#2809 で「決める必要がある」とされていた点）:

- 取得に失敗したら `currentSessionId` を直前の値へ戻す。
- ただし**戻すのは、失敗した ID がまだ選択中のときだけ**。行 A（遅い）→ 行 B（速い、成功）
  と続けてクリックし、その後 A が失敗した場合に B から引き剥がしてはいけない。
  この判定は `shouldRestorePreviousSelection()` として `utils/session/sessionLifecycle.ts`
  （純粋ルール置き場）に置き、単体テストで固定する。
- 呼び出し側の既存フォールバック（route watcher の `createNewSession()`、
  `resumeOrCreateChatSession` の `if (!sessionMap.has(topId)) createNewSession()`）は
  そのまま残る。`loadSession` の契約（失敗時は sessionMap に入らないまま返る）は変えない。

## 変更しないもの

- `data-testid`（`session-item-<id>` / `session-row-menu-<id>` / `session-row-menu-popover-<id>` /
  `session-row-bookmark-<id>` / `session-row-delete-<id>`）は据え置き。既存 e2e がそのまま通る。
- 行の a11y 契約（`role="button"` / `tabindex="0"` / `aria-label` / `.self` 付き Enter・Space /
  `event.repeat` 無視）は #684 のまま子へ移送する。
- ポップオーバーの排他制御（`openMenuId` と document クリックリスナ）と削除確認ダイアログは
  親に残す。子は「開いているか」を bool で受け取るだけ。

## 実測（修正前 / 修正後）

Playwright（Chromium、同一マシン・同一 fixture）で **クリック → 行に選択枠が付くまで** を
`MutationObserver` で計測。両方のセッションを先に `sessionMap` へ載せてから測るので、
ネットワークは経路に入らず、**一覧の再描画コストだけ**を見ている。12 サンプルの中央値:

| セッション数 | 修正前 | 修正後 |
| --- | --- | --- |
| 200 | 17.6 ms | 3.2 ms |
| 800 | 62.5 ms | 5.0 ms |

修正前は行数に比例して伸びる（4 倍で 3.6 倍）。修正後はほぼ横ばい（1.6 倍）で、
再描画が O(行数) でなくなったことが確認できる。Chromium での数字なので、#2809 の
「Safari の Vue パッチは Chrome の約 3.7 倍」を踏まえると Safari の改善幅はこれより大きい。

案3 の効果は別に確認する（下記 e2e）。上表の経路はどちらの版でも `currentSessionId` を
同期的に書くので、この数字には案3 は含まれていない。

## レビューで判明した追加修正（PR #2813）

案3（選択を fetch より先に進める）は、**「選択 ID が URL より先に動く」という新しい状態**を生む。
これが既存コードの 3 箇所の前提を崩していて、いずれもレビュー中に判明した。

1. **stale な成功レスポンスで activate しない**（CodeRabbit）
   A（遅い）→ B の順にクリックし、後から A が返ると `activateSession(A)` で A に飛ばされる。
   レース自体は PR 以前からあるが、失敗パスにだけ同趣旨のガードを入れて成功パスを無防備に
   残すのは一貫しないため、両分岐で同じ述語（`isAwaitedSession`）を使う。
   ユーザーが移動済みでも **transcript は sessionMap に残す** — 中身は正しいので次回の往復が消える。

2. **`activateSession` が選択 ID を書き戻さない**（この PR が入れたバグ。1 の e2e を書いていて発覚）
   `activateSession` は URL が既に対象を指すとき `navigateToSession` をスキップする（#762: 再 push で
   query string が落ちるため）。**そのスキップは `currentSessionId` の書き込みも巻き添えにしていた**。
   選択 ID が常に URL と一緒に動いていた頃は無害。A（遅い）→ B（URL が指しているセッション）と
   クリックすると、選択枠が A に貼り付いたままになる。当該分岐でも ID を書くようにした。

3. **失敗した読み込みでセッションが既読になる**（Codex。当初「稀」として見送ったが撤回）
   `currentSessionId` が先に進むと App.vue の既読 watcher が発火する。transcript が 500 で
   meta サイドカーが健全なら mark-read は成功し、**「新着あり」の信号が復元不能に失われる**。
   既読クリアの起点を `activeSession`（= `sessionMap` に載って初めて定義される）に変更。
   購読管理は引き続き `currentSessionId` の watcher に残す（クリック時点で走るのが正しい）。

教訓: 「選択を楽観的に先行させる」変更は、**選択 ID と URL の同期を暗黙の前提にしていた
コードすべて**を洗い出す必要がある。build も既存テストも通ったまま壊れる。

## 検証

- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build` / `yarn test`
- e2e: 既存の `history-panel` / `a11y-clickable-rows` / `router-navigation` /
  `session-history-side-panel` が testid 据え置きでそのまま通ること。
- 追加 e2e（`history-panel.spec.ts`）:
  - `/api/sessions/:id` を保留し、**レスポンスが返る前に**行へ選択枠 (`border-blue-500`) が付く
  - A（遅い）→ B の順にクリックし、後から A が返っても **B から引き剥がされない**
  - transcript が 500 のとき、行が**未読の太字のまま**・選択枠が付かない・URL が動かない・
    `mark-read` が 0 回
- 追加単体テスト: `isAwaitedSession` の 3 分岐。
- 追加ガード（`test/components/test_session_history_row_wiring.ts`）: 案1・案2 は**振る舞いを
  変えないので既存テストが全部緑のまま壊せる**。親がハンドラを裸の識別子で渡すこと、行の
  文字列生成が computed であることをソース parse で固定する。Vue コンポーネントの unit test
  基盤が無いリポなので、既存の `test_stackview_googlemap_wiring.ts` と同じ方式。
- **各テストが修正を外すと落ちることを個別に確認済み**（回帰ガードとして機能することの実証）。
