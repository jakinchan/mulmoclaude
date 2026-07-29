// Keeps the Firestore command channel alive across outages — the ring OUTSIDE
// `startHostRunner` (#2633, moved into core by #2643).
//
// The inner ring recovers in place: it re-subscribes its listener with backoff and
// notices when its own presence writes stop being acknowledged. When even that runs
// out it calls `onClosed` and stops. This ring starts a WHOLE new runner (fresh
// listener, fresh presence write), and only when relaunching stops helping does it
// pass the closure through, so the client can escalate to a full re-auth from its
// parked blob — the only path that fixes an actually-dead credential.
//
// The give-up rule is TIME, not a count of relaunches, so a long outage does not
// burn through a budget while nothing can possibly succeed.
//
// It lives here rather than in each host because its correctness is a relation
// between constants: SETTLE_MS must outlast `LISTEN_RETRY_WINDOW_MS`'s reporting
// delay, and PROBE_INTERVAL_MS must sit above `presenceStaleAfterMs()`. While the
// two hosts each kept a copy, raising LISTEN_RETRY_WINDOW_MS from ~31s to 5 minutes
// silently disabled `giveUp` in the copy that had not been told (#2643).
import type { RunnerHealth, RunnerHealthState } from "../health.js";
import type { HostRunnerOptions } from "./hostRunner.js";
import type { RemoteHostLogger } from "./lifecycle.js";
import type { Liveness } from "./presenceProbe.js";

const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;

const RECONNECT_BASE_MS = ONE_SECOND_MS;
const RECONNECT_MAX_MS = ONE_MINUTE_MS;
// When to ask, after a launch, whether the new runner actually works.
const SETTLE_MS = ONE_MINUTE_MS;
// Past this, retrying in place cannot help: an expired credential needs the
// browser's parked blob, which only the client can replay.
const GIVE_UP_MS = 5 * ONE_MINUTE_MS;
// How often to ask whether the phone can still see us. Slower than the one-minute
// heartbeat, because the question is "are the beats landing", not "did this one".
const PROBE_INTERVAL_MS = 90 * ONE_SECOND_MS;

export const reconnectDelayMs = (attempt: number): number => Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);

/** Cancels a scheduled task. Handing back a closure rather than a timer handle keeps
 *  the seam free of platform timer types, so a test clock is an ordinary function. */
export type CancelTimer = () => void;

export interface ResilientHostRunnerDeps {
  /** Starts the host runner, returning its stop function. Throws if the session is gone. */
  start: (options: HostRunnerOptions) => () => void;
  /** The options the lifecycle handed us; `onClosed` is passed on only once we give up. */
  options: HostRunnerOptions;
  /** Positive liveness check (`createPresenceProbe`). Without one, recovery falls back
   *  to trusting silence — which is what let a dead channel report itself green. */
  checkAlive?: () => Promise<Liveness>;
  /** State changes, for a host that renders channel health. Optional: a host with no
   *  such UI should not have to pass an empty function. */
  onHealth?: (health: RunnerHealth) => void;
  log: Pick<RemoteHostLogger, "info" | "warn">;
  schedule?: (task: () => void, delayMs: number) => CancelTimer;
  now?: () => number;
}

interface RunnerContext {
  deps: ResilientHostRunnerDeps;
  schedule: (task: () => void, delayMs: number) => CancelTimer;
  now: () => number;
  stopUnderlying: (() => void) | null;
  cancelTimer: CancelTimer | null;
  attempt: number;
  downSinceMs: number | null;
  lastError: string | null;
  state: RunnerHealthState;
  stopped: boolean;
  cancelProbe: CancelTimer | null;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const scheduleWithTimeout = (task: () => void, delayMs: number): CancelTimer => {
  const timer = setTimeout(task, delayMs);
  return () => clearTimeout(timer);
};

// The observer belongs to the host, and reporting a state must not be able to
// prevent reaching it. A throwing `onHealth` inside `giveUp` would swallow the
// `onClosed` that follows it — losing the one escalation that gets a dead
// credential re-authenticated, over a bug in a toolbar indicator. Same reasoning
// as `presenceBeat`'s `notify`, and the log is where there is left to say it.
const setState = (ctx: RunnerContext, next: RunnerHealthState): void => {
  ctx.state = next;
  try {
    ctx.deps.onHealth?.({ state: next, lastError: ctx.lastError, changedAt: ctx.now() });
  } catch (error) {
    ctx.deps.log.warn(`host runner health observer threw: ${errorText(error)}`);
  }
};

const clearTimer = (ctx: RunnerContext): void => {
  ctx.cancelTimer?.();
  ctx.cancelTimer = null;
};

const clearProbe = (ctx: RunnerContext): void => {
  ctx.cancelProbe?.();
  ctx.cancelProbe = null;
};

// Only worth asking while we believe we are up: during a reconnect the answer is
// already known, and the recovery it would trigger is the one already running.
function scheduleProbe(ctx: RunnerContext): void {
  if (ctx.stopped || !ctx.deps.checkAlive) return;
  clearProbe(ctx);
  ctx.cancelProbe = ctx.schedule(() => void runProbe(ctx), PROBE_INTERVAL_MS);
}

// `alive: null` (no probe wired, or nothing judgeable yet) is not an answer — the
// caller must read it as neither alive nor dead. `reason` describes a "no".
interface LivenessAnswer {
  alive: Liveness;
  reason: string;
}

const STALE_REASON = "presence went stale — the phone can no longer see this host";

async function askAlive(ctx: RunnerContext): Promise<LivenessAnswer> {
  try {
    return { alive: (await ctx.deps.checkAlive?.()) ?? null, reason: STALE_REASON };
  } catch (error) {
    // The read itself could not reach the server, which answers the question it
    // was asking.
    return { alive: false, reason: `presence probe failed: ${errorText(error)}` };
  }
}

async function runProbe(ctx: RunnerContext): Promise<void> {
  ctx.cancelProbe = null;
  if (ctx.stopped || ctx.state !== "online") return;
  const answer = await askAlive(ctx);
  // A state change while the read was in flight means someone else is already on it.
  if (ctx.stopped || ctx.state !== "online") return;
  if (answer.alive === false) {
    ctx.lastError = answer.reason;
    ctx.deps.log.warn(`host runner ${answer.reason}`);
    onUnderlyingClosed(ctx);
    return;
  }
  scheduleProbe(ctx);
}

// The inner runner leaves its (already dead) snapshot registration in place when it
// goes offline, so release it before starting another one — otherwise every
// reconnect cycle adds one more.
const releaseUnderlying = (ctx: RunnerContext): void => {
  const stop = ctx.stopUnderlying;
  ctx.stopUnderlying = null;
  try {
    stop?.();
  } catch (error) {
    ctx.deps.log.warn(`host runner teardown failed: ${errorText(error)}`);
  }
};

// The channel is genuinely back, so the outage budget and the backoff ladder start
// fresh for the next one.
const markRecovered = (ctx: RunnerContext): void => {
  ctx.downSinceMs = null;
  ctx.attempt = 0;
  // The incident is over, so its error stops describing the channel: kept, it
  // would be reported as the cause of whatever outage comes next.
  ctx.lastError = null;
  if (ctx.state === "online") return;
  ctx.deps.log.info("host runner re-subscribed");
  setState(ctx, "online");
  scheduleProbe(ctx);
};

// One settle window after a launch, ask whether the new runner actually works. A
// "no" keeps the outage clock running, which is what eventually escalates to the
// client; anything else (a "yes", or no probe to ask) accepts the recovery.
async function settle(ctx: RunnerContext): Promise<void> {
  ctx.cancelTimer = null;
  if (ctx.stopped) return;
  const answer = await askAlive(ctx);
  if (ctx.stopped) return;
  if (answer.alive === false) {
    ctx.lastError = answer.reason;
    ctx.deps.log.warn(`host runner is up but still unreachable — ${answer.reason}`);
    onUnderlyingClosed(ctx);
    return;
  }
  markRecovered(ctx);
}

const giveUp = (ctx: RunnerContext): void => {
  ctx.stopped = true;
  clearProbe(ctx);
  ctx.deps.log.warn(`host runner stayed down for ${Math.round(GIVE_UP_MS / ONE_SECOND_MS)}s, giving up (${ctx.lastError ?? "no error reported"})`);
  setState(ctx, "offline");
  ctx.deps.options.onClosed?.();
};

function scheduleRelaunch(ctx: RunnerContext): void {
  const delayMs = reconnectDelayMs(ctx.attempt);
  ctx.attempt += 1;
  ctx.deps.log.warn(`host runner closed (${ctx.lastError ?? "no error reported"}); re-subscribing in ${Math.round(delayMs / ONE_SECOND_MS)}s`);
  // Re-announcing on every relaunch would restamp `changedAt`, and a UI reading it
  // as "down since" would reset to zero each cycle of the outage it is reporting.
  if (ctx.state !== "reconnecting") setState(ctx, "reconnecting");
  ctx.cancelTimer = ctx.schedule(() => launch(ctx), delayMs);
}

function onUnderlyingClosed(ctx: RunnerContext): void {
  if (ctx.stopped) return;
  releaseUnderlying(ctx);
  clearTimer(ctx);
  clearProbe(ctx);
  ctx.downSinceMs ??= ctx.now();
  if (ctx.now() - ctx.downSinceMs >= GIVE_UP_MS) giveUp(ctx);
  else scheduleRelaunch(ctx);
}

// Which failures describe the CHANNEL. A handler that threw is worth logging but
// says nothing about reachability, and remembering it would let it be quoted as the
// cause of an unrelated outage minutes later.
const CHANNEL_METHODS = new Set(["listen", "presence"]);

const runnerOptions = (ctx: RunnerContext): HostRunnerOptions => ({
  ...ctx.deps.options,
  onEvent: (event) => {
    // The error code is the one thing that says whether the credential or the
    // network is at fault, so keep the latest for the log lines above.
    if (event.phase === "error") {
      const text = `${event.method}: ${event.message ?? "no detail"}`;
      if (CHANNEL_METHODS.has(event.method)) ctx.lastError = text;
      ctx.deps.log.warn(`host runner event error — ${text}`);
    }
    ctx.deps.options.onEvent?.(event);
  },
  onClosed: () => onUnderlyingClosed(ctx),
});

function launch(ctx: RunnerContext): void {
  ctx.cancelTimer = null;
  if (ctx.stopped) return;
  try {
    ctx.stopUnderlying = ctx.deps.start(runnerOptions(ctx));
  } catch (error) {
    // The session was torn down under us (currentFirestore throws when disconnected).
    ctx.lastError = errorText(error);
    onUnderlyingClosed(ctx);
    return;
  }
  ctx.cancelTimer = ctx.schedule(() => void settle(ctx), SETTLE_MS);
}

export function startResilientHostRunner(deps: ResilientHostRunnerDeps): () => void {
  const ctx: RunnerContext = {
    deps,
    schedule: deps.schedule ?? scheduleWithTimeout,
    now: deps.now ?? Date.now,
    stopUnderlying: null,
    cancelTimer: null,
    attempt: 0,
    downSinceMs: null,
    lastError: null,
    state: "online",
    stopped: false,
    cancelProbe: null,
  };
  // Announce the starting state rather than assuming the owner knows it: a
  // (re)connect is also what clears the notice left behind by the previous outage.
  setState(ctx, "online");
  launch(ctx);
  scheduleProbe(ctx);

  return () => {
    ctx.stopped = true;
    clearTimer(ctx);
    clearProbe(ctx);
    releaseUnderlying(ctx);
  };
}
