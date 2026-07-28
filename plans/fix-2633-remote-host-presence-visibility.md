# The host says it is online while the phone sees it offline

Issue: #2633 · symptom report: receptron/mulmoterminal#1045 · first raised as a core follow-up in receptron/mulmoterminal#823

## The trap

Two facts are supposed to agree and are computed on separate paths.

The phone decides "can I reach the Mac" from the freshness of `users/{uid}/hosts/{hostId}`,
written by a 60-second heartbeat. The host decides "am I connected" from listener errors
alone. So a presence write can fail forever while `onSnapshot` stays quiet, and nothing on
the host disagrees with itself: `status()` keeps saying connected, no reconnect is
attempted, and opening a browser tab doesn't help because the tab only reconnects when the
server admits it is disconnected.

The second half is the listener give-up rule: five bounded retries, ~31 s total, with the
counter reset only by a successful snapshot. One laptop sleep outlasts it, and after that
the host never re-subscribes.

## The part the issue got slightly wrong, and why it matters

The issue proposes counting consecutive `setDoc` rejections. That would miss the common
case. Firebase's own typing says it (`@firebase/firestore/dist/index.d.ts:2598`):

> Note that the returned `Promise` does _not_ resolve until the data is written to the
> backend […] if the client is offline, the returned `Promise` will not resolve for a
> potentially-long time.

An unreachable backend produces a write that **hangs**, not one that rejects. A rejection
counter would sit at zero through exactly the outage it was built to catch.

So the sensor is **acknowledgement age**: when did a presence write last land? That is one
number, it covers rejections and hangs alike, and it is the same question the phone asks —
"is the document fresh".

## Change

### core — `packages/core/src/remote-host/server/presenceBeat.ts` (new)

The heartbeat's decisions, with the Firestore write injected so they can be tested with a
fake clock and a promise that never settles:

```ts
createPresenceBeat({ write, onAck, onStale, onError, staleAfterMs, now })
  → { beat, announce, ackAgeMs }
```

- `announce(online)` fires the write and records `lastAckMs` when it resolves; a rejection
  goes to `onError` (it never reached `onEvent` before — hole 1's visibility half).
- `beat()` first asks whether the last ack is older than `staleAfterMs`; if it is, it calls
  `onStale` INSTEAD of writing. Writing again would just queue another mutation behind the
  ones already stuck.

Default staleness is three heartbeats (3 min). One missed beat is a blip; three is the
phone having nothing fresh to read.

### core — `hostRunner.ts`

1. Wire the beat above; `onStale` runs the same `goOffline()` a fatal listener error runs.
   The host stops claiming to be online, which is what lets the existing 15-second client
   poll (`src/composables/useRemoteHost.ts:35`) re-attach from its parked blob.
2. `goOffline()` now also detaches the listener. It didn't, so every recovery cycle left a
   dead snapshot registration behind (mulmoterminal's wrapper works around this today).
3. Listener give-up moves from a retry COUNT to a TIME window (`LISTEN_RETRY_WINDOW_MS`,
   5 min) measured from the first failure, cleared by a healthy snapshot. `backoffDelayMs`
   still uses the attempt number — that part was fine.
4. `unauthenticated` moves from fatal to transient. The SDK refreshes tokens; a credential
   that is genuinely dead now takes the 5-minute window and then escalates, instead of
   stopping the host on the first blip. `permission-denied` stays fatal.

### core — `lifecycle.ts`

The default `onEvent` logged `phase` and `method` and dropped `message` — the one field
carrying the Firestore error code. It now logs the message when present.

### host — `server/remoteHost/resilientRunner.ts` + `presenceProbe.ts` (ported)

Ported from mulmoterminal (`server/backends/remoteHost/`), which has run them since #825.
They are the OUTER ring; core's fixes are the inner one, and they do different jobs:

| | core (inner) | host wrapper (outer) |
|---|---|---|
| listener died | re-subscribes in place, 5 min | relaunches the WHOLE runner, 5 min, then surrenders to the client's re-auth |
| presence not landing | write-ack age, from this side | reads the doc back **from the server** — the phone's own vantage point |

The probe is not redundant with the ack sensor: the ack says "my write was accepted", the
probe says "the document a phone would read is fresh". Both are cheap; the second is the
question that actually matters, and answering it needs a server read (never the cache — a
cached copy of our own unsent write answers "fresh" precisely when it isn't).

Judged unjudgeable → do nothing: no document, an unresolved `serverTimestamp`, or a
deliberate `online: false`. A false positive spins a reconnect loop, which is worse than
the wait.

MulmoClaude has no health UI and this PR does not add one; the wrapper reports through the
host logger. (mulmoterminal surfaces `RunnerHealth` in its toolbar — that stays there.)

## Tests

- `packages/core/test/remote-host/test_presenceBeat.ts` — stale after 3 silent beats, ack
  resets the age, a rejection reports and does NOT count as an ack, a write that never
  settles goes stale (the case a rejection counter misses), an ack that lands late clears it.
- `packages/core/test/remote-host/test_hostRunner.ts` — extended: `unauthenticated` is now
  transient, the give-up rule is time-based (survives a 31 s outage, gives up past 5 min).
- `test/remoteHost/test_resilientRunner.ts` — relaunch on closure, backoff ladder, settle
  window resets the budget, give up after 5 min, probe failure routes into recovery.
- `test/remoteHost/test_presenceProbe.ts` — the freshness rule, including the three
  unjudgeable cases.

## Not in this PR

- **#2634** (`undefined` in a handler reply kills the whole write) — same file, unrelated
  failure. Separate PR so each stays reviewable.
- Publishing `@mulmoclaude/core`. mulmoterminal only benefits once it is on npm, and it can
  drop its own copies of both wrappers then; that is the `/publish` flow, not this PR.
