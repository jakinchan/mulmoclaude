# feat(plugins): 全プラグインルートにセッションの直近結果を渡す (#2758)

## Request

#2709（MindMap の `add_node` が 500）は MindMap 固有ではなく、**ホストが空 context を渡している**
ことに起因するプラグイン横断の問題だった。プラグイン側 14 リポは対応済み。

issue のホスト側の求めは3点:

1. server bridge が `currentResult` を渡していない ── ステートフル機能が原理的に動かない
2. `context.app` が server bridge 側に存在しない
3. `gui-chat-protocol` の型（`context: ToolContext`）が実挙動と食い違っている

## このリポジトリで実際に効く範囲（調査結果）

issue は 14 プラグインを挙げているが、**mulmoclaude が依存しているのは 7 つだけ**で、
さらにそのうち **3 つはコードから一度も import されていない**（`package.json` に宣言があるだけ）:

| パッケージ | このホストでの状態 |
|---|---|
| `@gui-chat-plugin/mindmap` | ルート結線あり（#2754 で `currentResult` 対応済み） |
| `@mulmochat-plugin/quiz` | ルート結線あり |
| `@gui-chat-plugin/present3d` | ルート結線あり |
| `@gui-chat-plugin/google-map` | ルート結線あり |
| `@gui-chat-plugin/browse` | **未使用**（宣言のみ、import ゼロ） |
| `@gui-chat-plugin/camera` | **未使用**（同上） |
| `@mulmochat-plugin/ui-image` | **未使用**（同上） |

issue が挙げた `currentResult` 系5件（AkinatorGame / DrawingGame / EditHtml / ScrollToAnchor /
SummarizePdf）と `context.app` 系のうち Browse 以外は、**このホストの依存ではない**。
Browse は依存だが未使用。

**つまり本 PR で閉じられるのは項目1のみ**で、それも「このホストが結線している4ルート＋
ホスト内製プラグイン」が対象。項目2・3は下記のとおり別。

## 方針

### 項目1 — `currentResult` を全ルートに配る（本 PR の中身）

#2754 で入れた `sessionToolContext(req, toolName)` を、**空 context を渡していた残りのルート**に
広げる。#2754 では「渡して壊れないか未検証」を理由に mindmap だけに絞ったが、**その検証こそが
この issue の依頼内容**なので、ここで進める。

対象（現在 `SERVER_TOOL_CONTEXT` を渡しているもの）:

- `executeQuiz` → `TOOL_NAMES.putQuestions`
- `executeForm` → presentForm
- `executePresentCollection` → presentCollection
- `executePresent3D` → `TOOL_NAMES.present3D`
- `executeMapControl` → `TOOL_NAMES.mapControl`

**安全性**: 渡すのは「そのツール自身の直近結果」だけ。別ツールの結果は混ざらない。
結果が無ければ従来どおり空 context にフォールバックするので、**初回呼び出しの挙動は不変**。
各プラグインの `execute` が `currentResult` を読んだときに何が起きるかは、
`currentResult` を持つ場合と持たない場合の両方をテストで固定する。

### 項目2 — `context.app` は本 PR では実装しない（理由を記録する）

`ToolContextApp` は `getConfig` / `setConfig` を要求し、実装は**ブラウザ側の状態**に依存する。
サーバから提供するには「サーバ側の config とは何か」を定義する必要があり、
プラグインごとに意味が変わる（`browseUrl` はブラウザを、`generateImage` はホストの API キーを想定）。

issue 自身が代案として「**意図的な制約なら、その旨をツール定義に反映して LLM に見せない**」を
挙げている。**このホストでは `context.app` を要求するプラグインを一つも結線していない**ため、
いま LLM に見えている壊れたツールは無い。実装も `isEnabled` での除外も、対象が現れてからで足りる。

### 項目3 — プロトコルの型は別リポジトリ

`gui-chat-protocol` は npm パッケージ（現在 `^1.2.0`、npm も 1.2.0）で、このリポジトリでは直せない。
型が `ToolContext | null | undefined` に広がった版が出たら bump する。**本 PR では上げない**
（上げるものが無い）。

### パッケージ更新

- `@gui-chat-plugin/browse` `^1.1.0` → `^1.1.1`（null ガード入り。**未使用だが宣言は最新に揃える**）
- `@gui-chat-plugin/mindmap` `^1.2.0` → `^1.2.1`

## テスト

`test/routes/test_sessionToolContext.ts` に追加:

- 結線した各ツール名について、直近結果があれば渡り、無ければ空 context になること
- **ツール間で結果が混ざらないこと**（quiz の結果が present3d に渡らない）

## スコープ外（PR に明記する）

- `context.app` の提供（項目2）
- `gui-chat-protocol` の型変更（項目3、別リポジトリ）
- 未使用3パッケージ（browse / camera / ui-image）のルート結線 ── 使っていないものを
  結線するのは本 issue の依頼ではない
