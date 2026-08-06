# fix(#2821): SKILL.md 本文がブリッジに返信として流れる

## 現象

Discord ブリッジ経由で Skill を呼ぶロールに話しかけると、ボットの返信が
`Base directory for this skill: …` で始まる SKILL.md 全文になる。Web UI では
折りたたみのスキルカードとして正しく表示される。

追加で判明した二次不具合: **アシスタントの回答が2回入る**。

## 測定（Claude CLI の生ストリーム）

`claude --output-format stream-json --include-partial-messages` を直接叩いて
raw イベントを採取。条件を2つ振った（入力 `-p` / stream-json、本文 1,350 字 /
8,900 字）が結果は同一。対照として Skill を使わないターンも採取した。

実パーサ (`server/agent/stream.ts`) を通した結果:

```text
tool_call        Skill
tool_call_result
text  len=8900   ← SKILL.md 本文（1イベント、delta ではない）
text  len=3      ← 回答の delta
text  len=49     ← 回答の delta
status           ← ここで初めて flush
```

生ストリーム上では:

| raw | 中身 |
|---|---|
| `{type:"assistant"}` の text block | アシスタント自身の発話 |
| `{type:"user"}` の `tool_result` block | ツール結果 |
| **`{type:"user"}` の text block** | **SKILL.md 本文（CLI が注入した文脈）** |

Skill を使わないターンには `user` ロールの **text block は一切現れない**
（`tool_result` のみ）。ユーザー自身のメッセージがエコーバックされることも無い。

## 根本原因

`blockToEvent()` が **メッセージのロールを捨てている**。`user` ロールの text
block（＝ CLI が注入した文脈）も、アシスタント自身の発話も、同じ
`{type:"text"}` イベントに潰される。

その結果 `handleAgentEvent()` は区別できないまま `pushSessionEvent()` で即配信し
(`agent.ts:676`)、あとから `pendingSkill` state machine で分類し直して
`skill` イベントを**再配信**する。

- **Web UI** … 末尾のテキストカードをスキルカードで「置換」して辻褄を合わせる
- **ブリッジ** … `collectAgentReply()` が `type: "text"` を素直に蓄積するので、
  分類前の生テキストを拾う

つまり「あとで撤回する暫定データを、確定データと同じ型・同じチャネルで配信して
いる」。差分を再構成できる消費者だけが偶然動いており、蓄積する消費者は必ず壊れる。

回答が2回入るのは、生テキスト（本文＋回答）を配信したうえで
`writeSkillEntry()` が `replyPart` を `text` として再配信するため。

## 方針

ロール情報を捨てないようにする。注入された文脈は最初から `text` として配信しない。

1. **`server/agent/stream.ts`** — `user` ロールの text block を専用イベント
   `injected_text` として emit する。ワイヤには出さない内部イベント。
2. **`server/api/routes/agent.ts`** — `injected_text` を処理:
   - `pendingSkill` あり → SKILL.md 本文。その場で `skill` エントリを書き出し・
     配信し、フラグを落とす。`text` としては配信しない。
   - `pendingSkill` なし → 想定外の注入。カナリアログを出し、**現状の挙動に
     フォールバック**（配信＋蓄積）。取りこぼしを作らない。
3. **`src/utils/session/sessionHelpers.ts`** — `applySkillEvent()` の
   「末尾のテキストカードを置換する」分岐を削除し、常に push する。
   本文がストリームされなくなるので、末尾は **Skill 呼び出し前のアシスタント自身の
   発話**（「まず bigskill スキルを使います」）になり、置換すると実際の出力が消える。

## 効き

- 全24ブリッジが自動的に正しくなる。**chat-service の変更は不要** →
  出荷はランチャー公開（`/publish-mulmoclaude`）だけで届く
- 回答のライブストリーミングは維持（assistant delta には手を触れないため）
- 回答の二重化も解消（本文と回答が同じ flush バーストに入らなくなる）
- jsonl の出力形状は不変

## 残すもの

`splitSkillAndReply()` は安全網として残す。新しい経路では注入テキストに本文しか
入らないので `replyPart` は空になるが、CLI が1ブロック内で連結する版があっても
正しく動く（その場合 replyPart は未配信なので配信が必要）。

## テスト

採取した生ストリームを `test/agent/fixtures/` に固定（`system` /
`rate_limit_event` 行と絶対パスを除去）。将来 CLI が本文を assistant ブロックへ
戻したら落ちる＝フォールバック経路に入ったことに気づける。

- `test/agent/test_injectedText.ts`（新規）— user ロール text block →
  `injected_text` / assistant → `text` / `tool_result` は不変。実ストリーム上で
  「本文が `text` イベントに載らない」ことを assert
- `test/agent/test_skillBridgeReply.ts`（新規）— 実ストリーム由来のイベント列を
  実際のブリッジ relay に流し、返信が「回答のみ・1回」になることを assert
- `test/agent/test_skillCanvasOrder.ts`（新規）— 実 `applyAgentEvent` に配信列を
  流し、「発話 → skill カード → 回答」の3枚がこの順で並ぶことを assert
  （置換をやめたことで発生しうる順序破壊の回帰テスト）
- `test/agent/test_skillTagging.ts` — 常に push する契約に更新

いずれも変異テストで「修正前のコードなら落ちる」ことを確認済み。

## 実機確認

- ブリッジ HTTP 経由で `nazonazo` スキルを起動 → 返信168字・SKILL.md 本文なし。
  同セッションの jsonl は `skill`(1839字) + `text`(168字) で従来と同形状
- Web UI（reload / ライブ SSE の両方）で「発話 → 折りたたみ skill カード → 回答」
  が正しく描画され、本文リーク・console error なし
