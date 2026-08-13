# lint warn 43 件を仕分け、直せるものを直して残りは error + grandfather (#2885)

## 方針

既存の `max-lines-per-function` が採っている形（`docs/lint-policy.md`）をそのまま他のルールにも広げる:

> ルールは repo 全体で `error`。動かせない既存違反だけ、末尾の1ブロックに**ファイル単位**で
> `warn` として理由付きで固定する。**追加禁止**、**消化したら削除**。

新しい流儀は作らない。「ディレクトリ全部 warn」にもしない — それだと未来の違反も warn 止まりで、
ラチェットにならない。

## 直したもの（6件）

| 箇所 | ルール | 直し方 | 副作用が無い根拠 |
| --- | --- | --- | --- |
| `packages/plugins/collection-plugin/src/env.d.ts` | `no-unsafe-assignment` ×2 | `declare module "*.vue"` を追加 | 型宣言のみ。**元々バグ**（下記） |
| `server/workspace/memory/migrate.ts` | `no-unsafe-assignment` | `new Array(n).fill(null)` → `Array.from({length:n},()=>null)` | 生成される配列が同一。`fill` は `any[]` の要素型を保つだけ |
| `packages/core/.../importCollection.ts` | `no-unsafe-assignment` | `Array.isArray` → 既存の `isUnknownArray`（`@mulmoclaude/common`） | `Array.isArray` は `unknown` を `any[]` に狭めるが、`isUnknownArray` は `unknown[]`。実行時コード不変 |
| `scripts/lib/devWatchIgnore.ts` | `super-linear-regex` | 末尾スラッシュ除去を `/\/+$/` からスキャンへ | 差分テストで実証（下記） |
| `scripts/packages/audit-releases.mjs` | `super-linear-regex` | `/\/?\*+.*$/` をスキャンへ | 同上 |

### collection-plugin の `env.d.ts` は実質バグだった

`*.css` しか宣言しておらず、他プラグイン（bookmarks / spotify / debug / recipe-book）にある
`*.vue` の shim が無かった。`vue-tsc` は `.vue` を解釈できるので `yarn typecheck` は通る一方、
**eslint の TS プログラムは解決できず** `ChatView` / `ChatPreview` が "error typed value" になり、
それが `no-unsafe-assignment` として出ていた。型の穴なので塞いだ。

### 正規表現の書き換えは走らせて等価を実証した

CLAUDE.md の「挙動を保つ変更は RUNNING で証明する」に従い、旧実装を使い捨てスクリプトに
持ち込んで新実装と並走させ、生成入力で全結果を比較した。

| 対象 | 入力数 | 差分 |
| --- | --: | --: |
| `devWatchIgnore` の `toPosix` | 6,874 | **0** |
| `audit-releases` の `shippedRoots` | 83,533 | **0** |

入力は部品の全組み合わせ（空 / `a` / `/` / `//` / `*` / `**` / `./` / `\` / `*/` / `**/*` …）に
加えて、病的に長い実行（スラッシュや星が 2,000 個）を混ぜた。比較後にスクリプトは削除。

## 直さなかったもの（37件）→ `error` + grandfather

### `@typescript-eslint/no-unsafe-assignment`（15件 / 13ファイル）

3つの族。いずれも `as`（禁止）か挙動変更なしには動かせない。

- **(a) `const parsed: T = JSON.parse(...)` / `await res.json()`**（10）— `JSON.parse` は `any`。
  代替は「毎回の parse に実行時スキーマ検査を入れる」しかなく、それは**今まで通っていた
  ペイロードを弾く**＝挙動変更。`src/utils/api.ts` には既にその旨のコメントがある。
- **(b) `Object.create(null)` → 型付き `Record`**（4）— TS は `Object.create` を `any` で返す。
  null プロトタイプは `__proto__` 対策として load-bearing（`src/tools/index.ts` は #1156 の
  Codex レビュー由来）。キャスト無しに型を付ける手段が無い。
- **(c) `req.body` の分割代入**（1, `dashboard.ts`）— 既存の `requestBodyRecord` で `unknown` には
  できるが、`tiles` は `writeDashboard` に `DashboardTile[]` として届く必要があるため、
  結局 `no-unsafe-argument`（既に error）に当たる。正攻法はタイル毎のバリデーション＝新しい挙動。

### `sonarjs/function-return-type`（12件 / 8ファイル）

union の戻り値が**契約そのもの**の箇所（`T | null` を返すパーサ、複数の結果形を返すツール
ハンドラ）。揃えると呼び出し側が受け取るものが変わる。lint 掃除ではなく設計変更。

### 正規表現3ルール（9件 / 3ファイル）

**ここは範囲を狭めた。** 従来は `scripts/**` 全体が `warn` で、その木の下ならどこに危険な
パターンを足しても warn 止まりだった。`error` にしてファイルを3つ挙げる形に変更:

- `deps.mjs` — 自リポジトリの TS を走査する import パターン。入力が first-party のソースで
  リクエストではないので backtracking はビルド速度の話。書き換えは依存監査そのものを壊す risk。
- `launcherSync.mjs` / `check-readme-translations.mjs` — **`safe-regex` の false positive**。
  各パターンが破綻するはずの病的入力（40,000 文字）で実測したところ、いずれも **~0.1ms＝線形**。
  直すべきものが無いので、書き換えずに掲載する。

### `sonarjs/reduce-initial-value`（2件）— どのリストにも載せない

素の `warn` のまま。2件とも呼び出し元が空配列で return / throw する seedless fold で、
各サイトにその旨のコメントがある。初期値を入れると到達しない分岐と広がった戻り値型が増えるだけ。
**この判断は #2736 で既に文書化済み**で、今回変えていない。

## 検証

- `yarn lint` **37 problems (0 errors)** / exit 0。
- **ラチェットが実際に噛むことを実証**した。未掲載のファイルに仮の違反を置いて計測:

  | probe | 結果 |
  | --- | --- |
  | `server/utils/` に `JSON.parse` 代入 + 複数戻り値型 | `2 errors` |
  | `scripts/` 直下に `/^(a+)+$/` | `2 errors`（`detect-unsafe-regex` + `slow-regex`） |
  | 掲載済み `launcherSync.mjs` | `2 warnings`（error にならない） |

  probe は計測後に削除。設定だけ見て「これで効くはず」とは判断していない。
- `yarn typecheck` / `yarn build` / `yarn format` すべて exit 0。
- `yarn test` **9313 件 0 fail**（＋ workspaces 107 件）。変更した `importCollection` /
  `audit-releases` / `deps` のテストも通過。
