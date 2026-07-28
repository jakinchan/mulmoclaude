// Unit tests for the recovery ring around core's host runner (#2633).
//
// core re-subscribes in place and, when that stops working, calls onClosed and
// stops. These pin what happens next: a whole new runner, backed off, given up on
// by TIME rather than by a count — and only then handed to the lifecycle so the
// client re-authenticates.
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

import type { HostRunnerOptions } from "@mulmoclaude/core/remote-host/server";
import { reconnectDelayMs, startResilientRunner, type ResilientRunnerDeps } from "../../server/remoteHost/resilientRunner.js";

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
    advance: (deltaMs: number) => {
      const targetMs = state.nowMs + deltaMs;
      for (;;) {
        const due = nextDue(targetMs);
        if (!due) break;
        pending.delete(due[0]);
        state.nowMs = due[1].atMs;
        due[1].task();
      }
      state.nowMs = targetMs;
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

const setup = (overrides: Partial<ResilientRunnerDeps> = {}) => {
  const clock = fakeClock();
  const runner = fakeRunner();
  const logs = { info: [] as string[], warn: [] as string[] };
  const stop = startResilientRunner({
    start: runner.start,
    options: {},
    log: { info: (msg) => logs.info.push(msg), warn: (msg) => logs.warn.push(msg) },
    schedule: clock.schedule,
    now: clock.now,
    ...overrides,
  });
  return { clock, runner, logs, stop };
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

describe("startResilientRunner", () => {
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
    const stop = startResilientRunner({
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
    startResilientRunner({
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
describe("startResilientRunner — presence liveness", () => {
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
