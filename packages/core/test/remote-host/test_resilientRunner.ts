// Unit tests for the recovery ring around `startHostRunner` (#2633, #2643).
//
// The inner runner re-subscribes in place and, when that stops working, calls
// onClosed and stops. These pin what happens next: a whole new runner, backed off,
// given up on by TIME rather than by a count — and only then handed to the
// lifecycle so the client re-authenticates.
//
// Two rules get their own coverage because they are the ones the failure taught:
//   - a liveness probe answering "the phone still cannot see us" is the same
//     outage as a listener death, even though nothing errored
//   - surviving the settle window does NOT count as recovery when the probe
//     disagrees; otherwise a dead credential relaunches forever and never escalates
//
// Time and the underlying runner are both injected, so nothing here waits.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { HostRunnerOptions } from "../../src/remote-host/server/hostRunner.js";
import type { RunnerHealth } from "../../src/remote-host/health.js";
import { reconnectDelayMs, startResilientHostRunner, type ResilientHostRunnerDeps } from "../../src/remote-host/server/resilientRunner.js";

const SETTLE_MS = 60_000;
const PROBE_MS = 90_000;
const GIVE_UP_MS = 5 * 60_000;

// Let scheduled async work (the settle check, a probe) run to completion.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface PendingTask {
  atMs: number;
  task: () => void;
}

// A controllable clock: the windows here are minutes long, so tests drive time
// rather than wait for it.
const fakeClock = () => {
  const state = { nowMs: 1_000_000, nextKey: 1 };
  const pending = new Map<number, PendingTask>();
  const nextDue = (targetMs: number): [number, PendingTask] | undefined =>
    [...pending.entries()].filter(([, timer]) => timer.atMs <= targetMs).sort(([, left], [, right]) => left.atMs - right.atMs)[0];
  return {
    now: () => state.nowMs,
    schedule: (task: () => void, delayMs: number) => {
      const key = state.nextKey;
      state.nextKey += 1;
      pending.set(key, { atMs: state.nowMs + delayMs, task });
      return () => {
        pending.delete(key);
      };
    },
    pendingCount: () => pending.size,
    // Time passing with the process NOT running — a system sleep, a blocked event
    // loop. Due timers stay pending and fire, late, on the next advance. `advance`
    // cannot express this: it runs every task at the exact moment it came due.
    sleep: (deltaMs: number) => {
      state.nowMs += deltaMs;
    },
    advance: (deltaMs: number) => {
      const targetMs = state.nowMs + deltaMs;
      for (;;) {
        const due = nextDue(targetMs);
        if (!due) break;
        pending.delete(due[0]);
        // Never backwards: after a `sleep` the due time is already in the past.
        state.nowMs = Math.max(state.nowMs, due[1].atMs);
        due[1].task();
      }
      state.nowMs = Math.max(state.nowMs, targetMs);
    },
  };
};

// A stand-in for core's runner: keeps the options each start was given, so a test
// can fire the onClosed core would have fired.
const fakeRunner = () => {
  const started: HostRunnerOptions[] = [];
  const stopCalls: number[] = [];
  return {
    started,
    stopCalls,
    start: (options: HostRunnerOptions) => {
      const index = started.length;
      started.push(options);
      return () => stopCalls.push(index);
    },
    /** Fire the closure core reports when its listener has died for good. */
    die: () => started.at(-1)?.onClosed?.(),
  };
};

// How far the fake wall clock sits from the fake elapsed clock. Offset on purpose:
// `changedAt` is an epoch the UI renders as a time, and a test in which both clocks
// read the same number could not tell one being used for the other (#2845).
const EPOCH_OFFSET_MS = 1_700_000_000_000;

const setup = (overrides: Partial<ResilientHostRunnerDeps> = {}) => {
  const clock = fakeClock();
  const runner = fakeRunner();
  const logs = { info: [] as string[], warn: [] as string[] };
  const wallNow = () => clock.now() + EPOCH_OFFSET_MS;
  const stop = startResilientHostRunner({
    start: runner.start,
    options: {},
    log: { info: (msg) => logs.info.push(msg), warn: (msg) => logs.warn.push(msg) },
    schedule: clock.schedule,
    now: clock.now,
    wallNow,
    ...overrides,
  });
  return { clock, runner, logs, stop, wallNow };
};

// An outage nothing recovers from: every relaunch is killed before it can settle,
// which is what a real dead credential or a closed laptop does.
const keepFailing = (clock: ReturnType<typeof fakeClock>, runner: ReturnType<typeof fakeRunner>, rounds: number): void => {
  Array.from({ length: rounds }).forEach((_, attempt) => {
    runner.die();
    clock.advance(reconnectDelayMs(attempt));
  });
};

// Advance and let the async settle/probe work finish before asserting.
const advanceAsync = async (clock: ReturnType<typeof fakeClock>, deltaMs: number): Promise<void> => {
  clock.advance(deltaMs);
  await flush();
};

describe("reconnectDelayMs", () => {
  it("doubles per attempt and caps at a minute", () => {
    assert.equal(reconnectDelayMs(0), 1_000);
    assert.equal(reconnectDelayMs(3), 8_000);
    assert.equal(reconnectDelayMs(6), 60_000);
    assert.equal(reconnectDelayMs(20), 60_000); // no overflow into an absurd delay
  });
});

describe("startResilientHostRunner", () => {
  it("starts the underlying runner immediately", () => {
    const { runner } = setup();
    assert.equal(runner.started.length, 1);
  });

  // The whole point: core stopping is not the end of the channel.
  it("relaunches after the underlying runner dies", () => {
    const { clock, runner } = setup();
    runner.die();
    assert.equal(runner.started.length, 1); // not yet — the backoff has to elapse
    clock.advance(1_000);
    assert.equal(runner.started.length, 2);
  });

  it("backs off further on each successive death", () => {
    const { clock, runner } = setup();
    runner.die();
    clock.advance(1_000);
    runner.die();
    clock.advance(1_999); // 2s this time, not another 1s
    assert.equal(runner.started.length, 2);
    clock.advance(1);
    assert.equal(runner.started.length, 3);
  });

  it("reports recovery once a relaunch survives the settle window", async () => {
    const { clock, runner, logs } = setup();
    runner.die();
    clock.advance(1_000);
    await advanceAsync(clock, SETTLE_MS);
    assert.deepEqual(logs.info, ["host runner re-subscribed"]);
  });

  it("restarts the backoff ladder after a recovery, instead of carrying it over", async () => {
    const { clock, runner } = setup();
    runner.die();
    await advanceAsync(clock, 1_000 + SETTLE_MS); // reconnect, then survive long enough to count
    runner.die();
    clock.advance(1_000); // 1s again, not 2s
    assert.equal(runner.started.length, 3);
  });

  // The regression the ring exists for: core counted retries, so ~31 seconds of
  // outage exhausted the budget for good.
  it("keeps retrying well past the old five-attempt budget", () => {
    const { clock, runner } = setup();
    keepFailing(clock, runner, 6); // 63s of continuous failure
    assert.ok(runner.started.length > 5, `only ${runner.started.length} launches`);
  });

  it("gives up after the outage window and reports the closure to its owner", () => {
    const closures = { count: 0 };
    const { clock, runner } = setup({
      options: {
        onClosed: () => {
          closures.count += 1;
        },
      },
    });
    keepFailing(clock, runner, 11); // 363s > the 5-minute window
    assert.equal(closures.count, 1);
  });

  it("stops retrying once it has given up", () => {
    const { clock, runner } = setup({ options: { onClosed: () => undefined } });
    keepFailing(clock, runner, 11);
    const startedWhenGivenUp = runner.started.length;
    keepFailing(clock, runner, 5);
    assert.equal(runner.started.length, startedWhenGivenUp);
  });

  // The owner's onClosed marks the session disconnected; sending it on every blip
  // would make a self-healed outage look like a dead session to the client.
  it("does NOT report a closure while it is still recovering", () => {
    const closures = { count: 0 };
    const { clock, runner } = setup({
      options: {
        onClosed: () => {
          closures.count += 1;
        },
      },
    });
    keepFailing(clock, runner, 6);
    assert.equal(closures.count, 0);
  });

  it("treats a throwing start as a failed attempt rather than dying", () => {
    const clock = fakeClock();
    const state = { starts: 0, failing: true };
    const stop = startResilientHostRunner({
      start: () => {
        state.starts += 1;
        if (state.failing) throw new Error("remote-host session is not open");
        return () => undefined;
      },
      options: {},
      log: { info: () => undefined, warn: () => undefined },
      schedule: clock.schedule,
      now: clock.now,
    });
    assert.equal(state.starts, 1);
    state.failing = false;
    clock.advance(1_000);
    assert.equal(state.starts, 2);
    stop();
  });

  it("keeps the error text from the listener, which the default logger drops", () => {
    const { clock, runner, logs } = setup();
    runner.started[0]?.onEvent?.({ phase: "error", method: "listen", message: "Missing or insufficient permissions." });
    runner.die();
    clock.advance(1_000);
    assert.ok(
      logs.warn.some((msg) => msg.includes("listen: Missing or insufficient permissions.")),
      logs.warn.join(" | "),
    );
  });

  // Kept across a recovery, an old error is reported as the cause of the NEXT
  // outage — diagnosis pointing at something that was fixed minutes ago.
  it("does not blame a new outage on the previous incident's error", async () => {
    const { clock, runner, logs } = setup();
    runner.started[0]?.onEvent?.({ phase: "error", method: "listen", message: "unavailable" });
    runner.die();
    await advanceAsync(clock, 1_000 + SETTLE_MS); // recovered
    runner.die(); // a fresh outage, this one with no error event of its own
    assert.ok(logs.warn.at(-1)?.includes("no error reported"), logs.warn.join(" | "));
  });

  // A handler that threw is worth logging, but it says nothing about whether the
  // phone can reach this host — quoted later as the cause of an outage, it sends
  // the reader after the wrong thing entirely.
  it("logs a handler-level error but does not remember it as the channel's", () => {
    const { clock, runner, logs } = setup();
    runner.started[0]?.onEvent?.({ phase: "error", method: "startChat", message: "handler blew up" });
    assert.ok(
      logs.warn.some((msg) => msg.includes("startChat: handler blew up")),
      logs.warn.join(" | "),
    );
    runner.die();
    clock.advance(1_000);
    assert.ok(logs.warn.at(-1)?.includes("no error reported"), logs.warn.at(-1) ?? "");
  });

  it("forwards events to the owner's handler", () => {
    const seen: string[] = [];
    const { runner } = setup({ options: { onEvent: (event) => seen.push(event.method) } });
    runner.started[0]?.onEvent?.({ phase: "done", method: "startChat" });
    assert.deepEqual(seen, ["startChat"]);
  });

  // core leaves its dead snapshot registration in place when it goes offline, so
  // every reconnect would stack another one up.
  it("tears the dead runner down before starting its replacement", () => {
    const { clock, runner } = setup();
    runner.die();
    clock.advance(1_000);
    assert.deepEqual(runner.stopCalls, [0]);
  });

  it("stops cleanly: no further starts, no pending timers", () => {
    const { clock, runner, stop } = setup();
    runner.die();
    stop();
    clock.advance(GIVE_UP_MS);
    assert.equal(runner.started.length, 1);
    assert.equal(clock.pendingCount(), 0);
    assert.deepEqual(runner.stopCalls, [0]);
  });

  it("survives a teardown that throws", () => {
    const clock = fakeClock();
    const captured: HostRunnerOptions[] = [];
    startResilientHostRunner({
      start: (options) => {
        captured.push(options);
        return () => {
          throw new Error("teardown blew up");
        };
      },
      options: {},
      log: { info: () => undefined, warn: () => undefined },
      schedule: clock.schedule,
      now: clock.now,
    });
    assert.doesNotThrow(() => captured[0]?.onClosed?.());
    clock.advance(1_000);
    assert.equal(captured.length, 2);
  });
});

// The silent failure: presence writes stop landing while the listener never errors,
// so nothing above ever fires and the host reports itself green for as long as the
// process lives. The probe is the sensor; these pin that a negative answer reaches
// the SAME recovery a listener death does, and that a healthy one changes nothing.
describe("startResilientHostRunner — presence liveness", () => {
  it("recovers when the host stops being visible, with no listener error at all", async () => {
    const state = { alive: true };
    const { clock, runner, logs } = setup({ checkAlive: () => Promise.resolve(state.alive) });
    assert.equal(runner.started.length, 1);

    state.alive = false;
    await advanceAsync(clock, PROBE_MS);
    assert.ok(
      logs.warn.some((msg) => msg.includes("presence went stale")),
      logs.warn.join(" | "),
    );
    clock.advance(60_000); // let the backoff elapse
    assert.ok(runner.started.length > 1, `only ${runner.started.length} launches`);
  });

  it("treats a probe that cannot reach the server as the outage it is", async () => {
    const { clock, runner, logs } = setup({ checkAlive: () => Promise.reject(new Error("unavailable")) });
    await advanceAsync(clock, PROBE_MS);
    assert.ok(
      logs.warn.some((msg) => msg.includes("presence probe failed: unavailable")),
      logs.warn.join(" | "),
    );
    clock.advance(60_000);
    assert.ok(runner.started.length > 1, `only ${runner.started.length} launches`);
  });

  it("keeps asking, and stays quiet, while the host is still visible", async () => {
    const probes = { count: 0 };
    const { clock, runner, logs } = setup({
      checkAlive: () => {
        probes.count += 1;
        return Promise.resolve(true);
      },
    });
    await advanceAsync(clock, PROBE_MS);
    await advanceAsync(clock, PROBE_MS);
    // Three asks, not two: the settle check inside the first window is the same
    // question, so it uses the same probe.
    assert.equal(probes.count, 3);
    assert.equal(runner.started.length, 1); // never torn down
    assert.deepEqual(logs.warn, []);
  });

  // A host that has never announced, or a document that moved. Reconnecting against
  // that would loop forever with nothing actually wrong.
  it("does not act on an answer it cannot judge", async () => {
    const { clock, runner } = setup({ checkAlive: () => Promise.resolve(null) });
    await advanceAsync(clock, PROBE_MS);
    await advanceAsync(clock, PROBE_MS);
    assert.equal(runner.started.length, 1);
  });

  it("stops probing once the runner is stopped", async () => {
    const probes = { count: 0 };
    const { clock, stop } = setup({
      checkAlive: () => {
        probes.count += 1;
        return Promise.resolve(true);
      },
    });
    stop();
    await advanceAsync(clock, PROBE_MS * 3);
    assert.equal(probes.count, 0);
  });

  it("resumes probing after a recovery, so a second silent death is caught too", async () => {
    const state = { alive: true };
    const { clock, runner, logs } = setup({ checkAlive: () => Promise.resolve(state.alive) });

    runner.die(); // an ordinary listener death
    await advanceAsync(clock, 1_000 + SETTLE_MS); // relaunch, then settle
    assert.deepEqual(logs.info, ["host runner re-subscribed"]);

    state.alive = false;
    await advanceAsync(clock, PROBE_MS);
    assert.ok(
      logs.warn.some((msg) => msg.includes("presence went stale")),
      logs.warn.join(" | "),
    );
  });

  // The delta from MulmoTerminal's version. core now retries for minutes before it
  // reports anything, so "still running after a minute" no longer proves the channel
  // works — and if that counted as recovery, the outage clock would reset on every
  // cycle and the client would never be asked to re-authenticate.
  it("does not count a settle window as recovery while the probe still says unreachable", async () => {
    const { clock, runner } = setup({ checkAlive: () => Promise.resolve(false) });

    await advanceAsync(clock, SETTLE_MS); // settle #1 → still unreachable
    clock.advance(1_000); // first backoff step
    assert.equal(runner.started.length, 2);

    await advanceAsync(clock, SETTLE_MS); // settle #2 → still unreachable
    clock.advance(1_000);
    // A cleared outage would have relaunched after 1s again; the ladder kept going.
    assert.equal(runner.started.length, 2);
    clock.advance(1_000);
    assert.equal(runner.started.length, 3);
  });

  it("escalates to the owner once the probe has said unreachable for the whole window", async () => {
    const closures = { count: 0 };
    const { clock } = setup({
      checkAlive: () => Promise.resolve(false),
      options: {
        onClosed: () => {
          closures.count += 1;
        },
      },
    });
    // Each cycle is a settle window plus its backoff step; ten of them outlast the
    // five-minute give-up window.
    for (const attempt of Array.from({ length: 10 }, (_, index) => index)) {
      await advanceAsync(clock, SETTLE_MS);
      clock.advance(reconnectDelayMs(attempt));
    }
    assert.equal(closures.count, 1);
  });
});

// The optional health feed a host renders in its toolbar. It is a REPORT of the
// state machine above, so what it must not do is as important as what it says: an
// outage has one `changedAt`, not one per relaunch, or a UI showing "down for N
// seconds" resets to zero every backoff step of the outage it is reporting.
describe("startResilientHostRunner — health reporting", () => {
  const withHealth = (overrides: Partial<ResilientHostRunnerDeps> = {}) => {
    const health: RunnerHealth[] = [];
    return { health, ...setup({ onHealth: (next) => health.push(next), ...overrides }) };
  };

  // A (re)connect is also what clears the notice left by the previous outage, so
  // the owner is told the starting state rather than assumed to know it.
  it("announces online at startup", () => {
    const { health } = withHealth();
    assert.deepEqual(
      health.map((entry) => entry.state),
      ["online"],
    );
  });

  it("reports reconnecting once, however many times it relaunches", () => {
    const { clock, runner, health } = withHealth();
    keepFailing(clock, runner, 4);
    assert.deepEqual(
      health.map((entry) => entry.state),
      ["online", "reconnecting"],
    );
  });

  it("reports offline when it gives up, so the UI can stop claiming self-healing", () => {
    const { clock, runner, health } = withHealth({ options: { onClosed: () => undefined } });
    keepFailing(clock, runner, 11);
    assert.equal(health.at(-1)?.state, "offline");
  });

  it("carries the channel error, and drops it again on recovery", async () => {
    const { clock, runner, health, wallNow } = withHealth();
    runner.started[0]?.onEvent?.({ phase: "error", method: "listen", message: "unavailable" });
    runner.die();
    assert.equal(health.at(-1)?.lastError, "listen: unavailable");

    await advanceAsync(clock, 1_000 + SETTLE_MS);
    assert.deepEqual(health.at(-1), { state: "online", lastError: null, changedAt: wallNow() });
  });

  // `changedAt` is documented as "ms epoch of the last state change, so the UI can
  // say how long it has been down". The clock the runner measures outages with is
  // monotonic and counts from process start, so stamping this from it would render
  // as 1970 (#2845).
  it("stamps each change with the wall clock, not the elapsed-time clock", () => {
    const { clock, runner, health, wallNow } = withHealth();
    clock.advance(5_000);
    runner.die();
    assert.equal(health.at(-1)?.changedAt, wallNow());
    assert.notEqual(health.at(-1)?.changedAt, clock.now());
  });

  // A host with no health UI passes no callback; nothing here may depend on one.
  it("runs the whole recovery with no callback at all", () => {
    const { clock, runner } = setup();
    assert.doesNotThrow(() => keepFailing(clock, runner, 11));
  });

  // The escalation this whole module exists to reach is the `onClosed` that
  // `giveUp` fires right after announcing "offline". A throwing indicator must not
  // be able to stand between the two, or a dead credential is never re-authenticated
  // because a toolbar had a bug.
  it("still escalates when the health observer throws", () => {
    const closures = { count: 0 };
    const { clock, runner, logs } = setup({
      onHealth: () => {
        throw new Error("observer blew up");
      },
      options: {
        onClosed: () => {
          closures.count += 1;
        },
      },
    });
    keepFailing(clock, runner, 11);
    assert.equal(closures.count, 1);
    assert.ok(
      logs.warn.some((msg) => msg.includes("health observer threw: observer blew up")),
      logs.warn.join(" | "),
    );
  });
});

// #2845. The give-up rule is TIME, and time is exactly what a frozen process keeps
// spending: a host reported "no presence write acknowledged for 459s" — a number
// its 60s beat could not reach while running — and by the time anything ran again
// the five-minute budget was gone, so the ring escalated to the client without one
// attempt against the network as it then stood. A gap in which nothing ran is not
// an outage the channel is responsible for.
describe("startResilientHostRunner — a gap in which nothing ran does not spend the budget", () => {
  const GAP_MS = GIVE_UP_MS + 60_000;

  it("does not give up when an overdue relaunch fires after a gap longer than the whole budget", async () => {
    const closures = { count: 0 };
    const { clock, runner, logs } = setup({
      options: {
        onClosed: () => {
          closures.count += 1;
        },
      },
    });
    runner.die(); // the outage starts; a relaunch is queued one second out
    clock.sleep(GAP_MS); // asleep / stalled: the wall clock moves, nothing runs
    await advanceAsync(clock, 0); // and now the overdue relaunch fires

    assert.equal(closures.count, 0, "gave up without one attempt against the network as it now stands");
    assert.equal(runner.started.length, 2, "the overdue relaunch still runs");
    assert.ok(
      logs.warn.some((msg) => msg.includes("resumed after a")),
      logs.warn.join(" | "),
    );
  });

  it("still gives up if the channel keeps failing after the gap", async () => {
    const closures = { count: 0 };
    const { clock, runner } = setup({
      options: {
        onClosed: () => {
          closures.count += 1;
        },
      },
    });
    runner.die();
    clock.sleep(GAP_MS);
    await advanceAsync(clock, 0);

    keepFailing(clock, runner, 11); // 363s of real, attempted failure > the 5-minute window
    assert.equal(closures.count, 1);
  });

  it("leaves the budget alone when a task merely fires on time", () => {
    const { clock, runner, logs } = setup({ options: { onClosed: () => undefined } });
    keepFailing(clock, runner, 11);
    assert.ok(!logs.warn.some((msg) => msg.includes("resumed after a")), "ordinary backoff must not read as a gap");
  });
});
