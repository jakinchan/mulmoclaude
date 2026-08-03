# derived formula の評価を反復化して RangeError の素通りを止める

Issue: #2711 · 関連: #2700 (パーサの反復化。ここで発見), #2692 (`as` 禁止。親)

## 何が壊れているか

`evaluateDerived` は「不正な式なら `null`」という契約だが、**評価中の
`RangeError: Maximum call stack size exceeded` だけが呼び出し元へ素通り**する。
tokenize と parse は try/catch 済みで、`evaluate(ast, ctx)` だけがその外側にある。

```ts
const value = evaluate(ast, ctx);   // ← try/catch の外
```

`evaluate()` は binop を再帰で降りる。パーサは `parseChain` が
`rest.reduce(...)` で**左結合**に畳むので、`1 + 1 + 1 + …` の AST は
**項数ぶんの深さの left spine** になる。よって式が長いと評価で落ちる。

`formula` はユーザー / エージェントが書く入力で、`deriveAll()` 経由でサーバ・
クライアント双方の描画に使われる。1 つの壊れたスキーマがそのコレクションの
描画ごと落とす。

再現 (`origin/main` = `82476276d`、1 プロセス 1 式):

```
n=6000  -> THREW RangeError: Maximum call stack size exceeded
n=12000 -> THREW RangeError
n=30000 -> THREW RangeError
n=60000 -> THREW RangeError
```

## 直し方

issue の案 1 (根治) を採る。案 2 (`evaluate` も try/catch) だけだと
**正しい長い式が黙って `null` になる**ままなので採らない。

`evaluate` を明示スタックの後順走査にする:

- `EvalStep` = `{ kind: "visit"; node }` | `{ kind: "apply"; operator }`
- binop に出会ったら `apply` → 右 → 左 の順に push (LIFO なので左から評価される)
- 葉 (`num` / `ident` / `ref` / `sum`) は `evaluateLeaf` が値を返して value stack へ
- `apply` は value stack から右・左を pop して `applyBinop`

再帰が消えるので、深さは AST の形ではなくヒープ上の配列長になる。
`evaluateLeaf` の引数型を `Exclude<Node, { kind: "binop" }>` にしたことで、
旧 `evaluate` 末尾の `throw new Error("unknown node")` (これも契約違反の throw だった)
は網羅性チェックで不要になり削除できる。**結果として `evaluate` は throw しない。**

## テスト

`test/utils/collections/test_derivedFormula.ts` の
「long operator chains parse ... without stack growth」ブロック (#2700 が追加) を拡張する。
このブロックは `TERM_COUNT = 2_000` を「評価側の (別の、既存の) 再帰限界より十分下」と
明記して避けていた。その限界がまさに本 issue なので、閾値を上げて評価側も踏む。

- `TERM_COUNT` を 2,000 → 50,000
- `+` / `*` / `-` / `/` の長い連鎖に加えて、
  ident・ref deref・`sum()` を混ぜた連鎖、優先順位が混ざる連鎖を追加

**閾値は固定しない**。issue の注意どおり、落ちる項数は JIT の温まり具合で動く
(cold で 6,000、warm なら 10,000 でも通る)。50,000 は観測したどの閾値よりも十分上で、
テストが見るのは「投げないこと」であって「N 項まで通ること」ではない。

## 検証で踏んだ罠 (記録)

テストは `@mulmoclaude/core/collection` を **`packages/core/dist` 経由**で import する。
ソースを直しただけでは `yarn test` は**古い dist を実行する**ので、
最初「修正前でもテストが通る」という誤った結果が出た。
`packages/core` を build してから測り直すのが ground truth:

- 修正前 (build 済み): 新規 5 件が `RangeError` で fail
- 修正後 (build 済み): 36 件 all pass
