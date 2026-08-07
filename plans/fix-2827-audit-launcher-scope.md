# fix(#2827): audit:releases がランチャーの app コード変更を検出できない

## 現象

`yarn audit:releases` は `mulmoclaude`（ランチャー）について、`server/` / `src/` の
変更を code drift として報告しない。#2824 が `server/agent/stream.ts` 等を変更して
マージされた直後も `manifest drift`（deps の差分のみ）としか出なかった。

## 原因

`scripts/packages/audit-releases.mjs:113` の drift 判定:

```js
const diff = run("git", ["diff", "--name-only", tag, "HEAD", "--", pkg.dir]);
```

`pkg.dir` はランチャーでは `packages/mulmoclaude`。ところがランチャーの `files` が
指す `server/` `src/` は **git 管理下になく、`prepack`（`bin/prepare-dist.js`）が
リポジトリルートからコピーして生成する**（`git ls-files packages/mulmoclaude/server`
は空）。よって diff の対象範囲に、ランチャーが実際に出荷するソースが入っていない。

`docs/package-releases.md` が明記するとおり app コードはランチャーでしか届かない
のに、それを検出するための監査がその変更だけを見られない状態だった。

## 方針

「パッケージのディレクトリ外にある出荷ソース」という概念を明示的に持たせる。

1. `EXTERNAL_SOURCE_ROOTS` を追加し、`prepare-dist.js` がルートからコピーする
   `server` / `src` / `Dockerfile.sandbox` / `sandbox-entrypoint.sh` を宣言する。
   該当するのはランチャーだけ。
2. `git diff` の pathspec に `pkg.dir` + external roots を渡す。
3. `isReleasePath()` を、パッケージ外のパスは **external roots に宣言されている場合
   だけ** 出荷対象と判定するよう明示化する。現状は「パッケージ外パスの相対化が
   素通りして `files` の root と偶然一致する」フォールスルーに依存していて脆い。
4. `deps.mjs` に倣い、純粋ヘルパを export し CLI 実行を直接起動時のみに限定して
   テスト可能にする。

ルート `package.json` は tarball に入らない（skill §1）ため対象外のまま。
ルート `src/` は vite で `dist/client` → `client/` にもなるので、`src` を見れば
クライアント側も覆える。

## テスト

`test/scripts/packages/test_auditReleases.ts`（新規）:

- ランチャーの diff pathspec に `server` / `src` が含まれる
- ルートの `server/agent/stream.ts` がランチャーの出荷対象と判定される
- 同じパスが**他のパッケージでは**出荷対象と判定されない（external roots は宣言制）
- ルート `package.json` は出荷対象でない
- 既存の判定（`src/` `bin/` `files` の root、README）が壊れていない

修正前のコードで落ちることを変異テストで確認する。

## ドキュメント

`docs/package-releases.md` の「what is actually drifting?」節に、ランチャーだけは
ルートの `server/` `src/` も監査対象であることを追記する。
