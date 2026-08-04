# refactor(#2807): Code Scanning に残る jscpd 重複3件を畳む

Code Scanning の open な `jscpd/duplicate-code` アラート #458 / #459 / #460 を、
検出器を騙すのではなく実際に単一ソース化して解消する。

## 対象クローン

| Alert | tokens | A | B |
|---|---|---|---|
| #458 | 91 | `packages/bridges/messenger/src/index.ts:87-100` | `packages/bridges/whatsapp/src/index.ts:137-148` |
| #459 | 54 | `packages/bridges/google-chat/src/index.ts:101-110` | `packages/relay/src/webhooks/jwt.ts:44-53` |
| #460 | 52 | `packages/core/src/collection/registry/server/skillDescription.ts:37-43` | 同ファイル `:56-60` |

## 方針

### 1. #458 — Meta webhook POST ハンドラを `@mulmobridge/webhook-runtime` へ

`registerMetaWebhookEvents(app, { rateLimit, appSecret, label, ackBody?, onBody })` を追加。

中身は両 bridge が持っていた骨格そのまま:

1. `x-hub-signature-256` ヘッダと raw body を取り出す
2. `verifyMetaHmacSignature` で検証、失敗なら `401 Invalid signature`
3. 先に 200 を返してから `onBody(rawBody)` を await（Meta のリトライ回避）

差分の吸収:

- **ack body**: messenger `EVENT_RECEIVED` / whatsapp `OK`。Meta はボディを無視するが
  観測可能な挙動を無闇に変えないため `ackBody` オプションで保持（既定 `EVENT_RECEIVED`）。
- **ログ**: whatsapp 側の `webhook signature verification failed` を、google-chat /
  messenger と同じ grep 可能な `AUTH_FAILED:` 形式に揃える（唯一の意図的な挙動変更）。

依存方向: bridges → webhook-runtime の下り。逆流なし。

### 2. #459 — JWS の3セグメント分割を `@mulmoclaude/common` へ

`splitJwtSegments(token): JwtSegments | null` を追加。純粋な文字列操作のみなので
Node bridge と Cloudflare Workers (relay) の双方で動く。デコード方式
（`Buffer` vs `atob`/`Uint8Array`）は各呼び出し側が引き続き自前で持つ。

「EXACTLY 3 セグメント、余りがあれば拒否」の根拠コメントは共有ヘルパに1本化する。

依存方向: relay → common, google-chat → common。両者とも既に `isRecord` を
同パッケージから import 済みなので新規の依存は増えない。

### 3. #460 — quoted scalar のスキャンループを1本に

`skillDescription.ts` 内に `scanQuotedScalar(value, quote, readEscape)` を切り出す。
`readEscape(value, index)` が 2 文字エスケープ対を消費できたときだけ文字列を返し、
それ以外は `null` を返す — という契約でダブル/シングル両方の差分を吸収する。

- double: `\` + 次文字 → `DOUBLE_QUOTE_ESCAPES` 適用（末尾 `\` はエスケープ扱いしない）
- single: `''` → `'`

`isOnlyTrailingComment` による閉じ後の検査と、未終端時の `null` は共通側に残す。

## 検証

1. `packages/core/test/collection-registry/test_skillDescription.ts` — 既存ケース全通過
   （quoted scalar の挙動が一切変わっていないこと）
2. `packages/webhook-runtime/test/test_webhook-runtime.ts` — `registerMetaWebhookEvents`
   の署名不正 / 正常系 / ack body / 処理エラー時の追加テスト
3. `packages/common/test/` — `splitJwtSegments` のテスト（3セグメント、短い、長い、空文字）
4. `packages/relay/test/test_google_chat_webhook.ts` 等の既存テスト全通過
5. `yarn format` → `yarn lint` → `yarn typecheck` → `yarn build` → `yarn test`
6. **外部 ground truth**: CI と同じ引数で jscpd をローカル実行し、
   対象3ペアが消え、新しいクローンが増えていないことをクローン数で確認する

## やらないこと

- publish はしない。`@mulmoclaude/common` / `@mulmobridge/webhook-runtime` に新 export が
  入るため、次に bridges を publish する際は bottom-up 順で先に両者を publish する必要がある
  — その旨は PR に記載する。
- `won't fix` で dismiss 済みのクローン（vite.config、`src/lang/index.ts`、
  `confirm.ts` 等）は触らない。
- whatsapp の `sendWhatsAppMessage` が `chunkText` を使わず自前でチャンク分割している件は
  jscpd に検出されておらず、スコープ外。
