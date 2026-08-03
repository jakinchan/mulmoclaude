# fix(tsconfig): 厳格化フラグを新規パッケージに伝える（#2778）

## 背景

#2772 で `packages/**` の tsconfig 59件すべてに `noUncheckedIndexedAccess` /
`exactOptionalPropertyTypes` が実効的に届いた（#2771 はそれでクローズ）。
既存パッケージは 52 個すべてが `typecheck` script を持ち CI が回すので、
明日 `arr[i]` を書けば落ちる。

**穴は新規側にある。** #2778 で挙げた3点:

| # | 穴 | 現状 |
|---|---|---|
| 1 | scaffold が吐く `tsconfig.json` に両フラグが無い | `strict: true` のみ。`strict` は両者を含まない |
| 2 | scaffold が `.vue` に plain `tsc` をかけている | `"typecheck": "tsc --noEmit"`、`vue-tsc` devDep 無し。テンプレートは `src/View.vue` を吐く |
| 3 | 両フラグを assert するゲートが無い | テストも CI ステップも無い。19個目の standalone は CI green で通る |

1 と 2 は同じ根。#2772 は `create-mulmoclaude-plugin` **自身**の tsconfig にはフラグを入れたが、
**それが生成するテンプレート文字列**（`src/template.ts`）は掃き残した。in-tree の
bookmarks / debug / recipe-book / spotify を `vue-tsc` に直したのと同じ修正が、scaffold には届いていない。

standalone 18個を共有ベースに寄せる案は **採らない**。ベースは `declaration: true` /
`types: ["node"]` を持ち `noEmit` / `jsx: "preserve"` / DOM libs を持たないため、
ブラウザ側プラグイン7個と `@cloudflare/workers-types` の relay に Node globals を渡してしまう。
18箇所の手書きコピーは残す前提で、**それをゲートで保つ**。

## やること

### 1. scaffold のテンプレートを reference plugin に揃える

`packages/create-mulmoclaude-plugin/src/template.ts`:

- `TSCONFIG` に `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` を追加
- `PACKAGE_JSON` の `"typecheck"` を `vue-tsc --noEmit` に
- `PACKAGE_JSON` の devDependencies に `vue-tsc` を追加

揃える先は in-tree の reference plugin である `packages/plugins/bookmarks-plugin`
（template.ts 冒頭の MAINTENANCE コメントが指定している同期先）。フラグ追加後、
`TSCONFIG` は bookmarks の `tsconfig.json` と**バイト一致**するはず。

### 2. 生成物が実際に両フラグ下で通ることを確認する

テンプレートを変えただけでは「生成されたプラグインが通る」ことにならない。
`View.vue` / `lang/index.ts` / `index.ts` を **vue-tsc + 両フラグ**で実際に走らせて 0 件を確認する。
plain `tsc` で確認しても意味が無い（`.vue` を読まないので、それが直そうとしている穴そのもの）。

手順: scaffold を実行 → 生成ディレクトリに monorepo の `node_modules` を渡して
`vue-tsc --noEmit` を実行 → 0 件を確認 → 生成物を破棄。

### 3. ゲートを1本入れる

`test/config/test_packageStrictFlags.ts`（`test/config/` は既に repo-config の契約テスト置き場）:

- `packages/**/tsconfig*.json` を全数走査し、**実効的に**両フラグが `true` であることを assert。
  文字列 grep だと `*.build.json` 7件（親経由でフラグを得ている）を誤検知するので、
  TypeScript の `readConfigFile` + `parseJsonConfigFileContent` で `extends` を解決した後の値を見る。
  TS 6.0.3 でこの API が extends を解決することは実測済み（base extends / standalone /
  `*.build.json` / relay の4形状で確認）。
- `.vue` を含むパッケージの `typecheck` script が `vue-tsc` であることを assert。
  plain `tsc` は `.vue` を1つも読まないので、これが無いと SFC が誰にも見られない状態を CI が見逃す。

scaffold テンプレート側の assert は、テンプレートを既にテストしている
`packages/create-mulmoclaude-plugin/test/test_template.ts` に置く（両フラグ / `vue-tsc` の2点）。
root の `yarn test` は `yarn workspaces run test` を回すので両方走る。

## やらないこと

- **standalone 18個の共有ベースへの寄せ** — 上記の理由により却下（#2771 で決着済み）
- **scaffold の devDeps caret 同期** — bookmarks は `vite ^8.1.5` / `@vitejs/plugin-vue ^6.0.8` /
  `vite-plugin-dts ^5.0.3` / `vue ^3.5.40`、テンプレートは `^8.0.10` / `^6.0.6` / `^5.0.0` / `^3.5.34`。
  MAINTENANCE コメントは同期を求めているが、これは #2778 以前からのドリフトで別件。PR で報告のみ。

## 完了条件

- scaffold の `TSCONFIG` が bookmarks の `tsconfig.json` と一致
- 生成されたプラグインが `vue-tsc --noEmit` で 0 件（実行して確認）
- `packages/**/tsconfig*.json` 59件のゲートが green、フラグを1つ外すと red になることを確認
- `yarn format` / `yarn lint` / `yarn typecheck` / `yarn build` / `yarn test`
