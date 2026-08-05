# feat(chat): 入力中の下書きをセッションごとに保存する (#2811)

## 背景

チャット入力欄の値は `src/App.vue` の `const userInput = ref("")` 1 本しかない。

- **リロードで消える** — どこにも永続化していない。
- **セッションをまたいで残る** — グローバル 1 本なので、A で書きかけて B に切り替えると B の入力欄に A の文字が出る。

一方 buffered メッセージ（実行中に送った分の chip）は `bufferedMessagesBySession` として既にセッション別に持っている。下書きも同じ形に揃える。

## 決定事項（ユーザ確認済み）

| 論点 | 決定 | 理由 |
|---|---|---|
| 下書きの単位 | **セッションごと**（`sessionId` がキー） | 切替で他セッションの文字が残らない。buffered と同じ形 |
| 保存先 | **sessionStorage** | リロード / タブ復元では残り、タブを閉じれば破棄。複数タブで下書きが混ざらない |
| 添付（`pastedFiles`） | **セッションごと。ただしメモリのみ** | テキストだけ直すと「文字は消えたのに前のセッションの添付 chip だけ残る」ので同じ PR で揃える。data URL（1件最大 30MB）は sessionStorage の quota に載らないため永続化しない＝リロードで消えるのは従来どおり |

## 消すタイミング（本 issue の肝）

「不要なときに前の文字が残る」を避けるため、下書きが消える経路を全部潰す。

| # | タイミング | 期待 | 実装位置 |
|---|---|---|---|
| 1 | 送信してエージェントに飛んだ | 下書き削除 | `sendMessage` の `userInput.value = ""`（setter が空文字でキーを消す） |
| 2 | 実行中に送信 → chip に積まれた | 下書き削除 | 同上（buffered 分岐の `userInput.value = ""`） |
| 3 | 添付の解決に失敗して差し戻し | 差し戻したテキストで復元 | 同上（`userInput.value = message`） |
| 4 | 入力欄を手で全消し | キーごと削除（空文字を残さない） | `setDraft` が trim 後空ならキー削除 |
| 5 | セッション削除（自タブ / 他タブの broadcast 経由） | そのセッションの下書き削除 | `useSessionSync` の `deletedIds` ループ |
| 6 | 空セッションの破棄 | そのセッションの下書き削除 | `useSessionLifecycle.removeCurrentIfEmpty` |
| 7 | 新規セッション（+） | 新しい id なので空 | 実装不要（キーが無い） |

5 と 6 を落とすと、到達不能なセッションの下書きが sessionStorage に溜まり続ける（孤児）。

## スコープ外

- 添付の**永続化**: セッション別にはするが sessionStorage には載せない（リロードで消えるのは現状どおり）。
- buffered メッセージの永続化: 現状どおりリロードで消える。必要なら別 issue。
- `PageChatComposer`（wiki / files ページの下書き）: 別コンポーネントのローカル state。

## 実装

### 1. `src/utils/chat/draftStore.ts`（純粋関数）

```ts
export const CHAT_DRAFTS_STORAGE_KEY = "chat_drafts_by_session";
export type DraftMap = Record<string, string>;

parseStoredDrafts(raw: string | null): DraftMap   // 壊れた JSON / 非 string 値を捨てる
serializeDrafts(drafts: DraftMap): string          // セッション id が空のエントリは永続化しない
setDraft(drafts, sessionId, text): DraftMap        // trim 後空ならキー削除、上限超えは古い順に捨てる
omitSession<T>(bySession, sessionId): Record<string, T>  // 下書きと添付の両方で使う破棄経路
```

- 上限 `MAX_DRAFT_SESSIONS`: 書き込みのたびに対象キーを末尾へ入れ直し、挿入順 = LRU として先頭から落とす。
- 空セッション id（起動直後の `currentSessionId === ""`）はメモリ上では持つが**保存しない** — 保存すると次のロードで新規セッションに他人の文字が出る。

### 2. `src/composables/useChatDrafts.ts`

`currentSessionId` を見て読み書きする `WritableComputedRef` を返す。既存の `currentBufferedMessages` と同じ形なので、`App.vue` 側の呼び出し（`userInput.value = ...` / `pastedFiles.value = []`）は 1 行も変えずに済む。

```ts
const { userInput, pastedFiles, dropDraft } = useChatDrafts(currentSessionId);
```

`dropDraft` はテキストと添付の両方を捨てる（破棄経路を 1 本にして「片方だけ消し忘れる」を作らない）。

書き込みは同期的に sessionStorage へ（debounce しない — 打った直後の ⌘R で末尾を落とさないため。下書きは小さいので JSON.stringify のコストは無視できる）。`setItem` は quota 例外を握って握りつぶす（保存できなくても入力は続けられる）。

### 3. 破棄フックの配線

- `App.vue`: `userInput` を `useChatDrafts` 由来に差し替え、`dropDraft` を下の 2 経路に渡す。
- `useSessionLifecycle`: `LifecycleDeps` に `dropSessionDraft` を追加し、`removeCurrentIfEmpty` が sessionMap から消したときに呼ぶ。
- `useSessionSync`: `deletedIds` ループで `onSessionDeleted?.(deletedId)` を呼び、App.vue が `dropDraft` を繋ぐ。

## レビュー指摘の反映

| 指摘 | 対応 |
|---|---|
| `sendMessage` の差し戻しが **別セッションの下書きを壊す** — setter は「書いた瞬間の `currentSessionId`」に解決されるが、`resolveAttachments` は実 POST で待ちが長く、その間に切り替えられる | await の前に `originSessionId` を捕まえ、差し戻しとエラー表示をそれに固定。composable に `restoreDraft(sessionId, text, files)` を追加（表示中でないセッションに書き戻す唯一の口） |
| `dropDraft` が変化なしでも毎回 `setItem` する（削除 broadcast の id ごと・セッション切替のたびに発火） | `commitDrafts` で「純粋関数が同じ参照を返した＝何も起きていない」を検出して書き込みをスキップ |
| 共有の空配列定数 `NO_FILES` を getter が返しており、呼び出し側が in-place で触ると全セッションに波及 | 定数をやめ、空セッションには毎回新しい `[]` を返す |

**CodeRabbit 指摘で追加対応**:

| 指摘 | 対応 |
|---|---|
| 削除済みセッションに下書きを戻してしまう（アップロード中に削除されると、破棄フックが消した直後に孤児を作り直す） | 先に `sessionMap.get(originSessionId)` を引き、生きているときだけ戻す |
| アップロード中にそのセッションで書き始めた文字を、差し戻しが上書きする | `restoreDraft` を上書きから **マージ** に変更（既存の `mergeBufferedIntoDraft` を再利用）。添付も新しくステージした分の前に連結 |
| 添付だけ上限が無く、メモリが無制限に増える | LRU を `putSession<T>` として切り出し、テキストと添付に同じ 20 セッション上限を適用 |
| e2e がアップロード開始を待っていないので、レースを検証しないまま通りうる | route ハンドラに「開始した」シグナルを足し、切替前に await。mock は `holdAttachmentUpload` / `recordAgentPosts` ヘルパへ抽出 |

**見送り（理由付きで PR に返信）**: `useChatDrafts` / `sendMessage` / テストの `describe` が 20 行を超える、という 3 件。lint の閾値は 50 行で通っており、リポジトリ内の既存 composable / テストも同じ形。分割すると同じ 2 つの ref を各ヘルパへ引き回すだけで、可読性が上がらないと判断した。

**Codex レビュー指摘で追加対応**: 成功経路の `sessionMap.get(currentSessionId.value)` も await 後に読むため、添付アップロード中にセッションを切り替えると **メッセージ自体が切替先のセッションに飛び、role もそちらのものになる**。当初は「変更前からある別バグなので別 issue」と判断したが、`originSessionId` が 3 行上にある状態で片方だけ直すのは一貫しないため同 PR で修正。`sessionRole` computed の中身を `roleOfSession(session)` に切り出し、送信は発信元セッションの role を使う。

## テスト

- `test/utils/chat/test_draftStore.ts`（node:test）: 保存 / 復元、空文字でキー削除、壊れた JSON、空 id を保存しない、LRU 上限、`omitSession` が添付マップでも動く。
- `test/composables/test_useChatDrafts.ts`（node:test, sessionStorage スタブ）: セッション別の読み書き、前回ロードからの復元、添付は永続化しない、空セッションには毎回新しい配列、`restoreDraft` が表示中でなく **composeしたセッション** に戻す、`dropDraft` が両方を消す（破棄経路 5・6 の実装本体）、下書きが無いセッションの drop で書き込みが増えない、storage 不通でも入力を失わない。
- `e2e/tests/chatinput-draft-persist.spec.ts`（mock）:
  1. 入力 → `page.reload()` → 値が復元される
  2. セッション A に入力 → B へ切替で空 → A に戻ると復元（URL 直叩き / タブ切替の両方）
  3. 新規セッション（+）は空
  4. 添付 chip も A → B で消え、A に戻ると復活
  5. 送信 → リロードしても空（送信済みの文字が復活しない）
  6. 手で全消し → リロードしても空
  7. 空セッションが破棄されたら、その id の下書きが sessionStorage から消える（破棄経路 6 の配線）
  8. アップロードを握ったままセッションを切り替えても、`/api/agent` の `chatSessionId` は発信元セッションのまま

破棄経路 5（削除 broadcast）の配線だけは e2e 化していない — socket.io モックを丸ごと立てる必要があり、実装本体（`dropDraft`）は composable の unit で押さえているため。

## 検証

`yarn format` → `yarn lint` → `yarn typecheck` → `yarn build` → `yarn test` → `yarn test:e2e`
