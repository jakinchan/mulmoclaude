# push の失敗を観測可能にする (#2903)

## 症状

「push が届かない」を調べた報告者が、サーバログを `web-push` / `webpush` / `push` で grep して
**1件もヒットしなかった**。その結果、次の2つが区別できなかった。

- push を送ろうとして失敗した（未サインイン / タイムアウト / 非2xx …）
- そもそも送ろうとしていない

実際は後者だったが、判定にコード読解が要った。#2886 の調査が長引いた直接の原因。

## 原因

`packages/web-push/src/index.ts` の `sendWebPush()` は、あらゆる失敗を `null` で返して何も記録しない。
呼び出し側（`server/agent/webPush.ts`）がログを出すのは **成功して届け先が0台のときだけ**。
`isPushEnabled` が false のときの早期 return も無音。

## 直し方

**never throw は正しい設計なので変えない。** 変えるのは「失敗が観測不能」の方だけ。

戻り値の型は変えない。`@mulmobridge/web-push` は npm 公開パッケージで、型を変えると major +
mulmoterminal 側の追従が要る。issue が挙げているもう一方の案（渡されたロガーに書く）を採る。

- `SendWebPushOptions` に `onFailure?: (failure: SendPushFailure) => void` を追加
- `SendPushFailure` = `{ reason: "not-signed-in" | "http-error" | "network" | "bad-response"; status?; message? }`
- 各 `return null` の前に理由を report する。`onFailure` が throw しても握る
  （never throw の契約は、ホスト側のハンドラが壊れても維持されなければ意味が無い）
- 既存の戻り値（`SendPushResult | null`）は不変 → **非破壊**。既存テストはそのまま通る

呼び出し側は3方向すべてを記録する。

- 失敗 → `log.warn("web-push", "sendPush did not deliver", { chatSessionId, ...failure })`
- 成功 → `log.info` で `sent` / `failed` / `targets`（0台のときは従来の文言のまま）
- 設定で無効 → `log.debug("web-push", "skipped — push is disabled in settings")`

**debug で十分な理由**: ファイルシンクの既定レベルが `debug`（`server/system/logger/config.ts`）で、
コンソールが `info`。つまり debug 行は `server/system/logs/` に残る —— 報告者が grep した先そのもの。
毎ターン出る行をコンソールに出さずに、grep には残せる。

## バージョン

`@mulmobridge/web-push` に runtime の export（型のみだが options の契約が増える）を足すので
1.0.1 → **1.1.0**。launcher の宣言レンジも `^1.1.0` に揃える。マージ後に publish が必要
（publish しないと npm 経由のホストには届かない）。

## テスト

`packages/web-push/test/test_web-push.ts` に9ケース追加（既存17は無改変で通る）。
理由ごとの report、成功時に report しないこと、`onFailure` が throw しても null を返すこと、
`onFailure` 無しでも動くこと（後方互換）。

## 関連

- #2886 — 起点
- #2901 — 完了 push の本文が固定（別軸、未着手）
