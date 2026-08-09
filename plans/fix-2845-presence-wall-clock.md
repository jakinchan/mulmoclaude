# fix(remote-host): presence の staleness と give-up を壁時計から切り離す

issue: #2845

## 何が壊れているか

ユーザー報告:

```
Remote host disconnected
Your phone can no longer reach this Mac. Last error: presence: no presence write acknowledged for 459s — the remote cannot see this host.
```

459 という数字がバグの証拠になっている。heartbeat は 60 秒、stale 判定は 3 beats = 180 秒
(`presenceBeat.ts` の `silentMs >= staleAfterMs`)。beat が正常に発火していれば silentMs は
60 → 120 → 180 と進むので、**真のオフラインでは必ず 180 秒で報告される**。何時間切れていても 180 秒。

459 秒が出るには、その1つ前の beat が 180 秒未満の時点を通っている必要がある。つまり
**約 280 秒以上、60 秒タイマーが1度も発火していない**。これは「通信が切れた」記録ではなく
「壁時計だけ進んで beat が動いていない」記録である。

そうなる原因は3つあり、現状のコードはどれも区別できない:

- システムスリープ（MacBook の蓋閉じ。プロセスが凍り、壁時計だけ進む）
- 時計のジャンプ（NTP のステップ補正、手動変更、VM / デュアルブートの時刻同期）
- イベントループの長時間ブロック

そして壊れ方は2段階ある:

1. **誤検知** — `presenceBeat` は経過時間だけで判定するので、「beat が実行されて失敗した」と
   「beat がそもそも実行されていない」を区別できない
2. **無試行 give-up** — `resilientRunner` の `onUnderlyingClosed` は
   `ctx.now() - ctx.downSinceMs >= GIVE_UP_MS`（壁時計・5分）で諦める。空白が5分を超えていると、
   **ネットワークが正常に戻った状態で1回も再接続を試さないまま** `giveUp` → `onClosed` →
   ホストは `offline`、ユーザーには手動再接続の通知が出る

## 直し方

### 1. presenceBeat: 経過時間ではなく「実際に走った beat の数」で判定する

`PRESENCE_STALE_BEATS = 3` は元々「3 beats」と言っている。それを時間に換算していたことが誤検知の
原因なので、換算をやめて beat を数える。

- `staleAfterMs` → `staleAfterBeats`
- ack が来たら 0 に戻す（今の `lastAckMs` リセットと同じ位置）
- `beat()` は「走った」ことを1つ数え、閾値に達したら stale

これで**時計を一切読まずに**判定できる。スリープ・時計ジャンプ・ストールのいずれでも beat は走って
いないので数は増えず、誤検知が原理的に起きない。真のオフラインでは今までどおり3回目の beat（180秒）で
stale になる。

`lastAckMs` は**報告用にのみ**残す（メッセージに載せる経過秒数）。判定には使わない。

`presenceStaleAfterMs()` の export はそのまま。あれは presence doc を**外から**読む probe が使う
サーバ時刻ベースの鮮度判定で、こちらの問題とは別のもの。

### 2. resilientRunner: プロセスが動いていなかった時間を outage 予算から外す

give-up は仕様どおり時間で測る（relaunch の回数ではない）。ただし「動いていなかった時間」は
チャネルが失敗していた時間ではないので、予算から外す。

- スケジュールしたタスクが**要求した遅延より大きく遅れて発火**したら、それはプロセスが動いていな
  かった証拠。`downSinceMs` を null に戻し（予算を測り直す）、backoff の段も 0 に戻す
- 閾値 `RESUME_GAP_MS` は 1 分。通常の負荷でタイマーが1分遅れることはない
- `now` の既定を単調時計にする。時計が**後ろに**飛ぶと `now() - downSinceMs` が負になり
  永久に諦めなくなるため、既定を `Date.now` のままにはしない

### 3. hostRunner: リスナ側の outage 時計も単調時計に

`handleListenError` の `downSinceMs` / `shouldGiveUpListening` も同じ壁時計依存。単調時計に替える。

`dispatchAddedCommands` の `Date.now()` は**そのまま**。あれはコマンドの `expiresAt`（サーバ時刻）
との比較なので、壁時計でなければならない。

## テスト

`now` と `schedule` はすべて注入可能なので、実時間を待たずに書ける。

- presenceBeat: 3 beats 走れば stale / 時計だけ飛んでも beat が走っていなければ stale にならない /
  ack で数が戻る / 境界（ちょうど 3 beats）
- resilientRunner: 予算超えの空白のあとにタスクが発火したら give up せず再試行する /
  通常の遅延では予算が測り直されない

## 影響しないもの

presence doc は `serverTimestamp()` で書かれるので、**スマホ側の「このホストが見えているか」の判定は
変わらない**。ホストが自分自身を誤診する部分だけの修正。
