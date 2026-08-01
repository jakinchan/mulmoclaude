# feat(markdown-plugin): 本文スタイルをプラグイン自身に持たせる（ホストの `.markdown-content` 依存を切る）

## Request

MulmoTerminal 側からの報告:

> presentDocument の表示精度が、MulmoClaude と MulmoTerminal で違うのはなぜ？
> MulmoClaude の方が、段落の表示とか、bullet points の表示とかがちゃんとできる。

同じ `@mulmoclaude/markdown-plugin@1.3.0` の同じ View を両ホストが描いているのに、
MulmoTerminal では段落の余白が無く、箇条書きの中黒が出ない。

## 原因

View は本文をこう包んでいる（`packages/plugins/markdown-plugin/src/plugins/markdown/View.vue:124`）:

```html
<div class="markdown-content prose prose-slate max-w-none" v-html="renderedHtml">
```

**`prose` / `prose-slate` はどちらのホストでも効いていない。** Tailwind Typography は
MulmoClaude にも MulmoTerminal にも入っていない（`src/index.css:16-22` のコメントが
まさにそう書いている）。実際に段落と箇条書きを描いているのは、MulmoClaude が手で書いた
グローバル CSS `src/index.css:23-121` の `.markdown-content` ルール群である。

プラグイン自身の scoped CSS（`View.vue:652-692`）が持っているのは `h1`〜`h6` だけ。
`p` / `ul` / `ol` / `li` / `code` / `pre` / `blockquote` / `a` / `hr` / `table` は
**ホストが用意している前提**になっている。

MulmoTerminal 側にはそのホスト CSS が無い:

- `src/` のどこにも `.markdown-content` ルールが無い（grep でゼロ件）。
- しかも `src/components/PluginFrame.vue` はプラグイン View を **Shadow DOM** に入れるので、
  仮に MulmoTerminal のグローバル CSS に同じものを書いても届かない（アイコンフォントで
  同じ問題を踏んでいて、`MATERIAL_ICONS_SHADOW_CSS` を shadow root に注入して塞いである）。
- さらに、プラグインが同梱する `dist/style.css` には Tailwind preflight が丸ごと入っており、
  shadow root の中で `ol,ul,menu{list-style:none}` と `*{margin:0;padding:0}` が効く。
  つまり MulmoTerminal は「スタイルが無い」のではなく、**中黒と段落余白が積極的に消されている**。

見出しだけまともで段落と bullet が崩れる、という報告された症状はこれで説明が付く。

## 決定事項

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| どちらのホストを直すか | **プラグイン側**（この plan） | View が自分で `prose` を付けている以上、その見た目の責任はプラグインにある。MulmoTerminal 側で shadow root に注入する案は、同じ CSS が 2 リポジトリに分裂する |
| MulmoClaude の `src/index.css` の `.markdown-content` | **消さない** | `presentDocument` 専用ではない。`plugins/textResponse/View.vue`、`plugins/skill/View.vue`、`plugins/manageSkills/SkillDetailPane.vue`、`CatalogDetailPane.vue`、および `.wiki-embed-*` が同じクラスに乗っている。消すとチャット本文が崩れる |
| プラグインに入れる値 | **`index.css` の値をそのまま写す** | MulmoClaude の presentDocument の現在の見た目を 1px も変えないため |
| `prose prose-slate` の扱い | **残す**（別途 issue にしない） | どちらのホストでも no-op。消しても直らないし、将来 Typography を入れたホストでは scoped ルールの方が詳細度で勝つので害も無い。今回の変更で「効いていない」ことをコメントに明記する |
| GFM タスクリストの中黒 | **今回は触らない** | `ul{list-style:disc}` を入れるとチェックボックス項目にも中黒が付くが、それは MulmoClaude の**現在の見た目**そのもの。パリティを崩さない方を選ぶ |
| 見出し | **本文と一緒に揃える**（下記「見出しのパリティ」） | プラグインの `h1`〜`h6` は font-size / weight / margin しか持たず、**色と `h2` の下罫線は index.css 側が描いていた**。本文だけ写すと見出しだけホスト依存が残る |

## 詳細度の確認（これが効くかどうかの肝）

Vue の `:deep()` は `.markdown-content[data-v-xxxx] p` にコンパイルされる — 詳細度 (0,2,1)。
MulmoClaude の `src/index.css` の `.markdown-content p` は (0,1,1)。**プラグイン側が勝つ。**

したがって MulmoClaude では「index.css は残るが、presentDocument の本文は今後プラグインの
scoped ルールが描く」ことになる。だから値を写し違えると MulmoClaude の表示が変わる。
写経は目視ではなく差分で確認すること。

（既に `h1` は同じ関係になっている: index.css は 1.5rem、プラグインは 2rem で、
presentDocument の見出しは今も 2rem で出ている。）

## 見出しのパリティ（「見出しは現状維持でよい」は誤り）

プラグインの `h1`〜`h6` が持っているのは `font-size` / `font-weight` / `margin` **だけ**。
それ以外のプロパティは、上書きが無いので index.css 側がそのまま描いている:

| プロパティ | index.css | プラグイン | MulmoClaude の実際 | MulmoTerminal |
| --- | --- | --- | --- | --- |
| `h1 color` | `#111827` | 無し | `#111827` | 継承（`PluginFrame` の `#111827`）— 偶然一致 |
| `h2 color` | `#1f2937` | 無し | `#1f2937` | `#111827` — **ズレる** |
| `h2 border-bottom` | `1px solid #e5e7eb` | 無し | 罫線あり | **罫線なし** |
| `h2 padding-bottom` | `0.25rem` | 無し | あり | なし |
| `h3` / `h4 color` | `#374151` | 無し | `#374151` | `#111827` — **ズレる** |
| `h5` / `h6` | 規則なし | font-size 等のみ | 継承 | 継承 — 一致 |

つまり「本文だけ写す」とホスト依存が見出しに残る。`h2` の下罫線は目で見て分かる差なので、
本文と同じ理屈（プラグインの見た目はプラグインで閉じる）で一緒に写す。

写す値は index.css のもの＝MulmoClaude の現在の見た目なので、詳細度で勝っても
MulmoClaude 側の表示は変わらない。`h5` / `h6` は index.css に規則が無いため追加しない。

## 変更内容

### 1. `packages/plugins/markdown-plugin/src/plugins/markdown/View.vue`

まず既存の `h1`〜`h4` ブロックに、index.css が描いていた分を足す:

- `h1` — `color: #111827`
- `h2` — `color: #1f2937; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.25rem;`
- `h3`, `h4` — `color: #374151`
- `h5`, `h6` — 変更なし（index.css に規則が無い）

その直後に、`src/index.css:53-121` から写した `:deep()` ルールを足す。対象は:

- `p` — `margin-bottom: 0.75rem; line-height: 1.6;`
- `ul, ol` — `margin-left: 1.5rem; margin-bottom: 0.75rem;` / `ul{list-style-type: disc}` / `ol{list-style-type: decimal}`
- `li` — `margin-bottom: 0.25rem; line-height: 1.5;`
- `code` — 背景 `#f3f4f6`、`padding: 0.1rem 0.3rem`、`border-radius: 0.25rem`、`font-size: 0.85em`、等幅フォント指定（`MS Gothic` / `BIZ UDGothic` を含む index.css のスタック）
- `pre` — 背景 `#f3f4f6`、`padding: 0.75rem`、`border-radius: 0.375rem`、`overflow-x: auto`、`margin-bottom: 0.75rem`
- `pre code` — `background: none; padding: 0; font-size: 0.85em;`
- `blockquote` — `border-left: 3px solid #d1d5db; padding-left: 1rem; color: #6b7280; margin: 0.75rem 0;`
- `a` — `color: #2563eb; text-decoration: underline;`
- `hr` — `border: none; border-top: 1px solid #e5e7eb; margin: 1rem 0;`
- `table` / `th, td` / `th` — index.css:106-121 のまま

`.wiki-embed-*`（index.css:122-147）は**写さない** — wiki プラグイン側の埋め込み用で、
presentDocument が出す HTML には現れない。

なぜこれを書くのか（`prose` が no-op であること、Tailwind preflight が
`list-style:none` と `margin:0` を掛けるのでホスト非依存にするには明示が要ること）を
`<style scoped>` の先頭にコメントで残す。ここが無いと、次の人が「Typography を入れれば消せる
重複」だと誤解して消す。

### 2. バージョンと公開

- `packages/plugins/markdown-plugin/package.json` を **1.3.0 → 1.4.0**（見た目の追加なので minor）。
- 同じ PR で `packages/mulmoclaude/package.json` の `@mulmoclaude/markdown-plugin` レンジを
  `^1.4.0` に上げる（launcher の workspace-lockstep を維持するため。launcher 自身の
  `version` は触らない）。
- publish は merge 後、既存のリリース手順（`/publish` skill）に従う。

### 3. MulmoTerminal 側（このリポジトリの変更が先、別 PR）

- `package.json` の `@mulmoclaude/markdown-plugin` を `^1.4.0` に上げるだけ。
  MulmoTerminal 側のコード変更は不要（`PluginFrame` が `dist/style.css` を shadow root に
  そのまま流し込んでいるので、プラグインの scoped ルールは自動的に効く）。
- MulmoTerminal は暗いパネルの中に白いカードを敷いている（`PluginFrame.vue:104-107` が
  `background:#ffffff; color:#111827`）。写す値はすべて明るい面向けの色なので整合する。

## 検証

- **MulmoClaude**: 変更前後で presentDocument を同じ .md に対して開き、スクリーンショットを比較。
  差分が出たら写経ミス。textResponse / skill / manageSkills の本文が無変更であることも確認
  （index.css を触っていないので変わらないはずだが、`.markdown-content` を共有しているので目視する）。
- **MulmoTerminal**: 1.4.0 を入れて presentDocument を開き、段落の余白・中黒・番号・テーブル罫線・
  コードブロックの背景・**h2 の下罫線と見出しの色**が MulmoClaude と同じに見えることを確認。
- 素材は見出し / 段落 / ネストした箇条書き / 番号付き / インラインコード / コードブロック /
  引用 / テーブル / 水平線 / リンク を全部含む .md を 1 枚作って使う。
- Marp モード（`marp-container`）は別経路（iframe に Marp が自前の CSS を入れる）なので影響しない
  ことも一応確認する。

## この plan が本当に言いたいこと

`prose prose-slate` はどちらのホストでも 1 度も効いたことが無く、実際の見た目は
**片方のホストのグローバル CSS がたまたま埋めていた**。共有プラグインが
「ホストが `.markdown-content` を持っている」ことに暗黙に依存していると、
持っていないホストで静かに崩れる — 型でも CI でも捕まらず、2 つ並べた人間だけが気付く。
共有プラグインの見た目は、そのプラグインの `dist/style.css` だけで閉じているべき。
