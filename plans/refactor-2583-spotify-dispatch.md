# spotify-plugin の dispatch を core/ に切り出す

Issue: #2583（spotify 37 / google 18 のうち **spotify 側**）· google 側は #2665 で完了（`ed462af`）

## google と同じ問題、違う形

google は「1 つの巨大な switch」だったが、spotify の `manageSpotify` の switch は既に
`handleConnect` / `handleStatus` / `handleListening` … と名前付きハンドラへ委譲している。
それでもテスト可能性はゼロで、理由は switch の長さではない:

**ハンドラが全部 `definePlugin` 内の `pluginRuntime` クロージャだから**。`files.config` も
`runtime.fetch` も外から差し替えられないので、`import` して呼ぶことすらできない。
結果、`test/plugins/spotify/` に 1,782 行のテストがありながら（client / listening / playback /
oauth / profile / search / tokens / normalize / schemas）、**dispatch だけ 1 行も無い**。

## 方針: runtime を router の外で束ねる

google では engine を `Pick<typeof GoogleEngine, …>` でそのまま注入したが、spotify の engine は
第1引数に `SpotifyDeps = { runtime, clientId, tokens }` / `FileOps` を取る。これをそのまま注入すると
**テストが PluginRuntime を丸ごと作る羽目になる**（既存テストの `makeFakeRuntime` が 40 行あるのがそれ）。

そこで **composition root（`index.ts`）で runtime を束ね**、router には runtime の出てこない
API だけを渡す:

```ts
// core/dispatch.ts が見る形
fetchLiked: (credentials: { clientId, tokens }, limit: number) => Promise<SpotifyClientResult<NormalisedTrack[]>>

// index.ts で束ねる
fetchLiked: (credentials, limit) => fetchLiked({ runtime, ...credentials }, limit)
```

シグネチャは手書きせず、実装から借りる:

```ts
type WithoutHostArg<F> = F extends (hostArg: infer HostArg, ...rest: infer Rest) => infer Result ? (...rest: Rest) => Result : never;
type Authenticated<F> = F extends (deps: infer Deps, ...rest: infer Rest) => infer Result
  ? (credentials: SpotifyCredentials, ...rest: Rest) => Result : never;
```

engine 側の引数が変わったら `index.ts` の束ね行がコンパイルエラーになる（drift しない）。

## 変更

### 新規 `src/core/dispatch.ts`

- `SpotifyCredentials` / `SpotifyApi`（25 メソッド）/ `SpotifyDispatchContext = { api, log, pubsub }`
- `executeSpotifyDispatch` — 1 ケース 1 行の router。`never` の網羅性ガードは
  **top-level と `invokeListening` / `invokePlayer` の 3 箇所**に置く（従来サブ switch には無かった）
- ハンドラを移設。`handleListening(kind, args)` の `kind` 引数を落とす — 呼び出し側は常に
  `kind === args.kind` だったので、`args.kind === "liked" ? … : 50` の到達しない分岐と
  `throw new Error("kind/args mismatch")` が消える
- `?? 50` / `?? 100` は `DEFAULT_TRACK_LIMIT` / `DEFAULT_PLAYLIST_TRACK_LIMIT` に

### 新規 `src/core/responses.ts`

LLM / View 向けの文字列を作る純粋関数（`summariseListening` / `summarisePlayerResult` /
`mapClientError` / `mapPlayerError` / `renderCallbackHtml` / setup 手順）。**文言は 1 文字も変えない**。
「Client ID 未設定」の 3 箇所はメッセージが違うが instructions は共通なので `clientIdMissing(message, html?)` に。

### `src/oauth.ts` / `src/index.ts`

- `SPOTIFY_SCOPES` は `buildAuthorizeUrl` と同居させる（`oauth.ts` へ移動）
- `index.ts` は composition root に。`bindApi(runtime)` と `exchangeCodeForTokens`（runtime.fetch を使う
  唯一の呼び出し）だけを持ち、あとは parse → `executeSpotifyDispatch`

### 新規 `test/plugins/spotify/test_dispatch.ts`

このプラグインのテストは**パッケージ内ではなく host 側**（`test/plugins/spotify/`）に置く既存慣習に従う。

- 全 19 kind の「呼ばれた engine 関数 + 渡された引数」を完全一致で検証
- **`getDevices` だけ premium gate を通らない**こと（Free アカウントでも View の
  デバイス一覧が要るため）。逆に他の player kind は Free なら Spotify を呼ばずに拒否する
- `play` の `contextUri` + `trackUris` 同時指定は**認証情報を読む前に**弾く
- oauthCallback の 4 分岐（拒否 / code 欠落 / 未知の state / 成功）と、交換失敗時に
  **token を書かない**こと・`clearProfileCache` が `writeTokens` の**後**に来ること
- limit の素通し（省略時しか見ないと「引数を無視する実装」が緑になる — google で見つけた穴）

## やらないこと

- 挙動の変更。文言・返り値の形・ログ・pubsub イベントは現状のまま
- `summariseListening` 内の既存 `as` キャスト。移設のみで、型の作り直しは別途
- 7 ケース以下のプラグイン（debug / edgar / markdown / recipe-book / bookmarks / email）
