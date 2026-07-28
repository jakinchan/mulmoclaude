# feat(#2617): macOS リマインダー通知の ON/OFF を設定画面から

アイコン起動（#2613 / PR #2615）ではフラグも環境変数も渡せない。つまり
**アイコンで起動した人にはこの機能を切る手段が存在しない**。ランチャーが塞いだ穴なので設定に出す。

CLI フラグ（`--disable-macos-reminders` / `DISABLE_MACOS_REMINDER_NOTIFICATIONS=1`）は残す。
これはサーバ運用者向けの経路で、今回足すのは GUI から届く経路。

## 決めたこと

| 論点 | 決定 | 理由 |
|---|---|---|
| 保存形状 | `AppSettings.macosRemindersEnabled?: boolean`（トップレベル） | `pushEnabled` と同型。単一フラグに `photoExif` のような入れ子は要らない |
| 既定値 | `true`（＝今の挙動を維持） | #789 は darwin で有効な状態で出荷済み。設定を足しただけで既存ユーザーの通知が消えるのは事故 |
| env との優先順位 | **env / CLI フラグが勝つ** | issue の要件「既存の `DISABLE_…=1` 利用者を壊さない」。起動時に明示したものが保存値に勝つのが筋。そして**アイコン起動はどちらも渡せない**ので、この issue が対象とするユーザーでは設定が唯一の権威になる |
| 効かない時の見せ方 | env で落ちている時はトグルを無効化し、理由を出す | 「押しても何も起きないトグル」は最悪。優先順位を決めた以上、負けた側に理由を見せるまでが仕様 |
| macOS 以外 | トグル自体を出さない | このシンクは darwin 以外では元から黙っている。死んだコントロールを並べるより隠す |

## いちばん危ないところ（実装の芯）

`server/system/macosNotify.ts` は **モジュール読み込み時に** `disabled` を確定している:

```ts
const defaultDeps: Deps = {
  disabled: env.disableMacosReminderNotifications || autoDisabledForTests,
};
```

設定は実行中に変わるので、ここを**呼び出しごとの評価**に変えないと
「トグルを切ってもサーバを再起動するまで通知が止まらない」になる。
設定画面のトグルとしては、それは壊れているのと同じ。

`Deps` の注入形（テストが偽の spawner / platform / disabled を差せる形）は壊さない。
公開エントリ `pushToMacosReminder` が毎回 `loadSettings()` を読んで `disabled` を組み立てる。

## 触るもの

| ファイル | 何を |
|---|---|
| `server/system/config.ts` | `macosRemindersEnabled` をインターフェース / キー表 / 型ガード / patch 正規化 / `saveSettings` 投影に足し、`isMacosRemindersEnabled(settings)`（既定 `true`）を足す |
| `server/system/macosNotify.ts` | `disabled` を呼び出し時評価にし、env・テスト自動無効・設定の 3 つを合成 |
| `server/api/routes/config.ts` | GET に `macosReminders: { supported, forcedOffByEnv }` を足す（クライアントは platform も env も自力では知り得ない） |
| `src/components/SettingsNotificationsTab.vue` | プッシュ通知トグルの隣に並べる。`supported` が false なら出さない。`forcedOffByEnv` なら無効化 + 理由 |
| `src/lang/*` | 8 言語ロックステップ（`docs/i18n.md`） |

## テスト

- `isMacosRemindersEnabled`: 未設定 → `true` / `false` を保存 → `false`
- 型ガード: `macosRemindersEnabled: "no"` を拒否
- `saveSettings` 投影: 往復して落ちないこと
- **`macosNotify`: 設定を切り替えたら「再起動なしで」次の呼び出しから効くこと** ← モジュール読み込み時固定の回帰を固定する本命
- env が立っている時は設定が `true` でも spawn しないこと
- GET が `supported` / `forcedOffByEnv` を返すこと

## 段取り

1. [ ] `config.ts`（保存形状 + reader）
2. [ ] `macosNotify.ts`（評価タイミング）
3. [ ] route GET
4. [ ] Vue + i18n 8 言語
5. [ ] テスト
6. [ ] `yarn format` / `lint` / `typecheck` / `build` / `test` → PR
