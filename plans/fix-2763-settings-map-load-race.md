# fix #2763 — Map タブの API キー入力が読み込み完了前に編集可能

## 背景

main の CI `e2e (2)` が
[run 30768313410](https://github.com/receptron/mulmoclaude/actions/runs/30768313410/job/91551517146)
で失敗した。

失敗テストは `e2e/tests/settings-target-narrowing.spec.ts` の
*Enter in the Maps API key field commits the key and drops focus* で、
`state.settings.googleMapsApiKey` が `undefined` のまま（= 保存 PUT が飛んでいない）。

## 根本原因

`SettingsMapTab` は `SettingsModal.vue:166` で `v-else-if="activeTab === 'map'"`。
つまり **Map タブをクリックした瞬間にマウント**され、`reloadToken` の
`immediate: true` watch から `GET /api/config` が飛ぶ。
入力欄はこの GET を待たずに最初から編集可能になっている。

`load()` は完了時に無条件で `apiKeyDraft.value = storedKey.value` を代入するため、
**「入力 → GET 到着 → Enter」の順**に並ぶと打った内容が空文字で上書きされる。
続く `save()` は `if (trimmed === storedKey.value) return;` に当たって早期 return し、
**エラーも出さずに保存しない**。

CI の失敗時スナップショット（`error-context.md`）もこれと整合する:
ステータスは "Not configured"、`settings-map-error` は非表示 =
`save()` が黙って no-op しただけの状態。

テストだけの問題ではなく、**サーバー応答が遅いときに実ユーザーが入力キーを失う実バグ**。

## 再現（外部 ground truth）

`/api/config` の GET を「`fill` と `press("Enter")` の間」に着地させる probe spec を
一時的に置いて実行 → CI と同一の

```
Expected: "AIzaTestKey123"
Received: undefined
```

で確定的に再現した。固定 delay（1.5s）では **再現しない**ことも確認済み
（その場合 save が先に走ってしまうため）。窓は「fill と Enter の間」だけ。

## 対応

`src/components/SettingsMapTab.vue`

- `loading` ref を追加（初期値 `true`）。`load()` の前後で true / false にする。
  失敗パスでも false に戻るよう `apiGet` の直後に置く（`loaded` は成功時のみ true のままなので、
  読み込み失敗後も入力・保存はできる）。
- 入力欄に `:disabled="loading"` と disabled 時の Tailwind ユーティリティを追加。

これで「まだ届いていない値の上に書ける」窓自体が消える。
Playwright の `fill()` は要素が enabled になるまで待つので、e2e 側の race も同時に消える。

## テスト

`e2e/tests/settings-target-narrowing.spec.ts`

- `mockConfig` に `getDelayMs` を追加（既定 0 = 従来どおり）。
- 回帰テスト
  *the Maps API key field is not editable until the stored key has loaded* を追加。
  GET を 1s 遅らせ、`toBeDisabled()` → `toBeEnabled()` → 入力 → Enter → 保存到達 を検証。

### 確認済み

- 修正なし + 新テスト → `Expected: disabled / Received: enabled` で落ちる（ガードが効いている）。
  同時に既存の失敗テストもローカルで確定的に落ちるようになった。
- 修正あり → `settings-target-narrowing` 3件 pass。
- `settings.spec` / `accounting-settings` 併せて 27 件 pass。
- `yarn format` / `yarn lint`（0 errors）/ `yarn typecheck` / `yarn build` すべて通過。

## スコープ外（別途検討）

`reloadToken` を使う他の Settings タブ（Notifications / Voice / ChatIndex / Photos /
Journal / Model）も同じ「マウント後に load が値を上書きする」形だが、
いずれも checkbox / select で、
「自由入力 + Enter で確定 + 変化なしなら no-op」という今回の組み合わせは持たない。
今回は Map タブに限定する。
