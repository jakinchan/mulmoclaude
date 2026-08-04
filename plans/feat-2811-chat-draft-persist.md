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

## テスト

- `test/utils/chat/test_draftStore.ts`（node:test）: 保存 / 復元、空文字でキー削除、壊れた JSON、空 id を保存しない、LRU 上限、`omitSession` が添付マップでも動く。
- `e2e/tests/chatinput-draft-persist.spec.ts`（mock）:
  1. 入力 → `page.reload()` → 値が復元される
  2. セッション A に入力 → B へ切替で空 → A に戻ると復元（URL 直叩き / タブ切替の両方）
  3. 新規セッション（+）は空
  4. 添付 chip も A → B で消え、A に戻ると復活
  5. 送信 → リロードしても空（送信済みの文字が復活しない）
  6. 手で全消し → リロードしても空

## 検証

`yarn format` → `yarn lint` → `yarn typecheck` → `yarn build` → `yarn test` → `yarn test:e2e`
