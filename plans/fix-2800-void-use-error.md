# fix #2800 — `sonarjs/void-use` を error に昇格する

## やること

`sonarjs/void-use` は型情報つきルールなので `sonarTypeAwareRulesAsWarn` の一括降格に入り、
実効 `warn`(`[1]`)になっている。**findings は 0 件**なので、移行作業なしで `error` に昇格できる。
#2743(枯れた13ルールを error に昇格)と同じパターン。

## 実測して確かめたこと

issue の主張をそのまま信じず、3 点とも実測した。

### 1. 現在の実効値は warn

```console
$ npx eslint --print-config server/index.ts | jq '.rules["sonarjs/void-use"]'
[1]
```

プラグインの metadata 側も確認: `requiresTypeChecking: true` かつ recommended は `"error"`。
つまり `sonarTypeAwareRulesAsWarn` の条件(型情報つき かつ recommended で有効)に合致して降格されている。

### 2. findings は 0 件(キャッシュなしで全ファイル)

`yarn lint` は `--cache` 付きなので、キャッシュが結果を隠しうる。キャッシュを使わず全スコープで測った:

```console
$ npx eslint src server test e2e e2e-live packages scripts batch config --format json
files linted: 2433
sonarjs/void-use findings: 0
```

同時に測った他の warn ルールには backlog が残っている(`no-unsafe-assignment` 19、
`function-return-type` 12、`super-linear-regex` 5 など)ので、「0 件」は
「lint が走っていない」ではなく **void-use だけが本当に枯れている**ことを示す。

### 3. `no-floating-promises` とは衝突しない — 引用ではなく実験で確認

issue は sonarjs の実装(promise を除外する分岐)を引用しているが、**引用は証拠にならない**ので、
ルールを `error` に強制して probe ファイルを流した:

```ts
const syncFn = (): number => 1;
const asyncFn = async (): Promise<number> => 1;
void syncFn();    // ← line 4
void asyncFn();   // ← line 5
```

```
line 4 sev=2 :: Remove this use of the "void" operator.
void-use findings in probe: 1
```

**非 promise の `void` だけが報告され、promise の `void` は報告されない。**
これで「0 件なのはルールが死んでいるから」という可能性も同時に潰せている(negative control)。

リポジトリ内の実例でも裏が取れる: `src/composables/useContentDisplay.ts:68` の
`void loadCspExtra()` は `async function loadCspExtra(): Promise<void>` を呼ぶ
fire-and-forget だが、void-use は報告していない。

## 実装

`sonarTypeAwareRulesAsWarn` の展開より **後ろ**に明示キーを置けば上書きされるので、
一括降格の仕組み自体には手を入れない(issue のチェックリスト2番目の答え)。
#2743 で昇格した13ルールと同じ置き方。

## 検証

- `--print-config` の実効値が `[1]` → `[2]` になること
- `yarn lint` が緑のままであること(0 件なので新規エラーは出ないはず)
- `yarn format` / `yarn typecheck` / `yarn build` / `yarn test`
