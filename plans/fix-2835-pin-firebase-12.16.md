# fix(remote-host): firebase を 12.16.0 にピン留めして Google サインインを直す（#2835）

## 問題

リモートホストの「Google でサインイン」が `Database is closing/hidden` で失敗し、
オフラインのまま繋がらない。macOS の Chrome / Safari の両方で、複数の利用者が再現している。

MulmoClaude 側のロジックの誤りではなく、**`@firebase/auth` 1.13.4 のリグレッション**
（上流 [firebase-js-sdk#10264](https://github.com/firebase/firebase-js-sdk/issues/10264)）。

## 原因

1.13.4 は `IndexedDBLocalPersistence` に `visibilitychange` リスナを追加し、
`document.visibilityState === 'hidden'` を**ページ teardown と同じ扱い**にした。

```js
// @firebase/auth 1.13.4 dist
this.onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') { this.onPageHide(); }  // isHiding = true, IndexedDB を close
    else if (document.visibilityState === 'visible') { this.onPageShow(); }
};
async _openDb() {
    if (this.isHiding) { throw new Error('Database is closing/hidden'); }
```

サインインのポップアップが元ウィンドウを背面に回すと `hidden` になり、
ポップアップから認証情報が戻ってきた時点の永続化で `_openDb()` が throw する。到達経路:

```
signInWithPopup → PopupOperation → _signIn
  → _signInWithCredential(auth, IdpCredential, bypassAuthState=false)
  → auth._updateCurrentUser → directlySetCurrentUser
  → assertedPersistence.setCurrentUser → IndexedDBLocalPersistence._set
  → _withRetries → _openDb → throw
```

`_withRetries()` は `isHiding` のときリトライせず rethrow するため回復経路が無い。
**読み取りは握りつぶすのに書き込みだけ致命的**という非対称がこの不具合の芯で、
`_poll()` は `isHiding` を見て `[]` を返すのに、`_set` / `_remove` は例外を上げる。

`signInWithPopup` が reject するので idToken を取得できず `/connect` に到達しない。
`errorMessage(err, fallback)` は Error の `message` を返すため、i18n フォールバックには
届かず SDK の生文字列がそのまま画面に出る。

## 調査で確定させたこと

| 確認 | 方法 | 結果 |
|---|---|---|
| エラー文字列の出どころ | SDK 全文検索 | `_openDb()` の1箇所のみ。出た時点で `isHiding === true` が確定 |
| リグレッションかどうか | 1.13.3 / 1.13.4 の tarball 差分 | `isHiding` / `visibilitychange` / 当該文字列は 1.13.3 に **0件**、1.13.4 で新規追加 |
| 実際に落ちるか | Playwright + Chromium で実 SDK を実行 | `indexedDBLocalPersistence` は hidden で throw、`inMemoryPersistence` は通る |
| 上流の状態 | GitHub API | PR #10300 が 2026-08-13 に merge 済み。ただし **npm 未公開** |
| 上げれば直るか | npm registry | `@firebase/auth` の latest は 1.13.4 のまま。`firebase@12.17.1`（最新）も 1.13.4 を同梱 |

## 方針: ピン留め

`firebase` を **12.16.0 に完全固定**する（`@firebase/auth` 1.13.3 を同梱する最新の 12.x）。

- `^12.16.0` ではなく `12.16.0`。キャレットだと 12.17.x に浮いて 1.13.4 に戻ってしまう。
- 対象は **2箇所**。ルートの `package.json` だけでは npm 利用者に届かない:
  - `package.json` — 開発・ビルド時に解決される。ブラウザ束は build 時に焼き込まれる
  - `packages/mulmoclaude/package.json` — ランチャーの runtime 依存。`server/` が
    `firebase/storage` を実行時に import するので、ここが `^12.17.0` のままだと
    npm 利用者側で 12.17.x が解決される
- `packages/core` は `firebase: ^12.0.0` を optional peer で宣言しており 12.16.0 で満たされる。変更不要。

### 却下した案

**`setPersistence(auth, inMemoryPersistence)` に切り替える**（issue の提案） — 回避としては
正しく、この Auth インスタンスは `signInWithPopup` で idToken を1回取るためだけに存在し、
`onAuthStateChanged` / `currentUser` / `getIdToken` は `src/` 全体に0件なので persistence
自体が不要、という前提も正しい。ただし `setPersistence()` は内部で**古い（IndexedDB）
persistence に対して `_get` + `_remove` を実行してから**切り替えるため、起動時にページが
hidden だとその呼び出し自体が同じエラーで reject し、投げっぱなしだと persistence は
IndexedDB のまま残って再発する。採るなら `getAuth` をやめて
`initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver })`
にすべきだが、**上流が既に直しており公開待ちなだけ**なので、アプリ側の認証初期化を
書き換えるより依存を固定して待つほうが差し戻しが容易と判断した。

**上流リリースを待つ** — 現時点では不可。1.13.3 → 1.13.4 は約6週間空いており、
修正版がいつ出るか読めない。

## 解除の手順

`@firebase/auth` が 1.13.5 以上（= PR #10300 を含む `firebase` リリース）を同梱したら:

1. `npm view firebase@latest dependencies.@firebase/auth` で 1.13.5 以上を確認
2. `yarn add firebase@^<新バージョン> -W` と `yarn workspace mulmoclaude add firebase@^<新バージョン>`
3. #2835 をクローズ

issue #2835 は**この PR では閉じない**。ピン留めは回避であって原因の除去ではなく、
上流版に戻すまでが完了だから。

### ピンが外れうる経路

`.github/dependabot.yml` は npm の version update を意図的に対象外にしている（#2875）ので
Dependabot が勝手に上げることはない。ただし**リポジトリ設定の npm security update と、
手動の `yarn upgrade --latest` はこのピンを外し得る**。外れたときの症状は #2835 そのもの。
