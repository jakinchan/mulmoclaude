import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";

import { NOOP_LOGGER } from "../../src/whisper/internal.ts";
import { createStartLifecycle, defaultSpawnServer } from "../../src/whisper/sidecar.ts";
import type { WhisperModelName } from "../../src/whisper/models.ts";

// Drive the lifecycle with a fake, SYNCHRONOUS `spawnServer` that hands back a
// REAL but inert child (so `proc` is a genuine ChildProcess — no unsafe cast)
// and a fake `waitReady` whose readiness we resolve/reject on demand. Port
// allocation is the one async step, matching the production seam. No HTTP.
const INERT_SCRIPT = "setInterval(function () {}, 1e9);";
const spawned: ChildProcess[] = [];

function spawnInert(): ChildProcess {
  const proc = spawn(process.execPath, ["-e", INERT_SCRIPT], { stdio: ["ignore", "ignore", "ignore"] });
  proc.unref();
  spawned.push(proc);
  return proc;
}

afterEach(() => {
  spawned.splice(0).forEach((proc) => proc.kill());
});

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface ReadyGate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function makeReadyGate(): ReadyGate {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Launch {
  proc: ChildProcess;
  port: number;
  gate: ReadyGate;
}

interface Harness {
  lifecycle: ReturnType<typeof createStartLifecycle>;
  spawnCalls: WhisperModelName[];
  launchAt: (index: number) => Launch;
}

function makeHarness(): Harness {
  const spawnCalls: WhisperModelName[] = [];
  const launches: Launch[] = [];
  const gateByProc = new Map<ChildProcess, ReadyGate>();
  const lifecycle = createStartLifecycle({
    allocatePort: async () => 40000 + launches.length,
    spawnServer: (model, port) => {
      spawnCalls.push(model);
      const proc = spawnInert();
      const gate = makeReadyGate();
      gateByProc.set(proc, gate);
      launches.push({ proc, port, gate });
      return proc;
    },
    waitReady: (proc) => gateByProc.get(proc)?.promise ?? Promise.reject(new Error("waitReady for unknown proc")),
    logger: NOOP_LOGGER,
  });
  // A missing launch means spawnServer was never called that many times — fail there, not on `.gate` of undefined.
  const launchAt = (index: number): Launch => {
    const launch = launches[index];
    assert.ok(launch, `expected a launch at index ${index}, got ${launches.length}`);
    return launch;
  };
  return { lifecycle, spawnCalls, launchAt };
}

describe("createStartLifecycle", () => {
  it("reuses a single in-flight start for concurrent requests of the same model", async () => {
    const harness = makeHarness();

    const first = harness.lifecycle.ensureSidecar("base");
    const second = harness.lifecycle.ensureSidecar("base");
    await flushMicrotasks(); // let the single start reach spawn
    assert.equal(harness.spawnCalls.length, 1);

    harness.launchAt(0).gate.resolve();
    const [sidecarA, sidecarB] = await Promise.all([first, second]);
    assert.equal(sidecarA, sidecarB);
    assert.equal(sidecarA.model, "base");
    assert.equal(harness.spawnCalls.length, 1);
  });

  it("shutdown kills the live sidecar", async () => {
    const harness = makeHarness();

    const pending = harness.lifecycle.ensureSidecar("base");
    await flushMicrotasks();
    harness.launchAt(0).gate.resolve();
    const active = await pending;
    assert.equal(active.proc.killed, false);

    harness.lifecycle.shutdown();
    assert.equal(active.proc.killed, true);
  });

  it("discards a start that finishes after shutdown (no stale publish)", async () => {
    const harness = makeHarness();

    const pending = harness.lifecycle.ensureSidecar("base");
    await flushMicrotasks(); // let the start register its in-flight child
    const firstLaunch = harness.launchAt(0);

    harness.lifecycle.shutdown(); // bumps the cancellation token + kills the in-flight child
    firstLaunch.gate.resolve(); // readiness resolves, but this start is now stale

    await assert.rejects(pending, /whisper-server start cancelled/);
    assert.equal(firstLaunch.proc.killed, true);

    // A fresh start must spawn a brand-new child, not resurrect the stale one.
    const retry = harness.lifecycle.ensureSidecar("base");
    await flushMicrotasks();
    assert.equal(harness.spawnCalls.length, 2);
    harness.launchAt(1).gate.resolve();
    const active = await retry;
    assert.notEqual(active.proc, firstLaunch.proc);
    assert.equal(active.proc, harness.launchAt(1).proc);
  });

  it("shuts down a live sidecar of a different model before starting the new one", async () => {
    const harness = makeHarness();

    const pBase = harness.lifecycle.ensureSidecar("base");
    await flushMicrotasks();
    harness.launchAt(0).gate.resolve();
    const base = await pBase;
    assert.equal(base.model, "base");
    assert.equal(base.proc.killed, false);

    const pSmall = harness.lifecycle.ensureSidecar("small");
    assert.equal(base.proc.killed, true); // switching shuts the old child down synchronously
    await flushMicrotasks();
    assert.equal(harness.spawnCalls.length, 2);

    harness.launchAt(1).gate.resolve();
    const small = await pSmall;
    assert.equal(small.model, "small");
    assert.notEqual(small.proc, base.proc);
  });

  it("propagates a readiness failure and clears the in-flight start", async () => {
    const harness = makeHarness();

    const pending = harness.lifecycle.ensureSidecar("base");
    await flushMicrotasks();
    harness.launchAt(0).gate.reject(new Error("boom"));

    await assert.rejects(pending, /whisper-server failed to start: boom/);
    assert.equal(harness.launchAt(0).proc.killed, true);

    // The failed start left no in-flight `starting` behind — a retry spawns again.
    const retry = harness.lifecycle.ensureSidecar("base");
    await flushMicrotasks();
    assert.equal(harness.spawnCalls.length, 2);
    harness.launchAt(1).gate.resolve();
    assert.equal((await retry).model, "base");
  });

  // Regression: shutdown must be able to kill a child the instant it is spawned.
  // The child is only ever exposed to shutdown via `startingProc`, assigned in
  // the SAME synchronous tick as the (synchronous) spawn — so once port
  // allocation resolves and the child exists, a shutdown reaches it with no await
  // gap, rather than the child surviving until waitReady times out.
  it("shutdown immediately kills a child once it is spawned (spawn/track adjacency)", async () => {
    let releasePort!: (port: number) => void;
    const portReady = new Promise<number>((res) => {
      releasePort = res;
    });
    const children: ChildProcess[] = [];
    const gates: ReadyGate[] = [];
    const gateByProc = new Map<ChildProcess, ReadyGate>();
    const lifecycle = createStartLifecycle({
      allocatePort: () => portReady,
      spawnServer: () => {
        const proc = spawnInert();
        const gate = makeReadyGate();
        gateByProc.set(proc, gate);
        gates.push(gate);
        children.push(proc);
        return proc;
      },
      waitReady: (proc) => gateByProc.get(proc)?.promise ?? Promise.reject(new Error("unknown proc")),
      logger: NOOP_LOGGER,
    });

    const pending = lifecycle.ensureSidecar("base");
    assert.equal(children.length, 0); // still awaiting the port — nothing spawned yet

    releasePort(45000);
    await flushMicrotasks(); // port resolves → spawn + startingProc handoff, one tick

    assert.equal(children.length, 1);
    const [child] = children;
    const [gate] = gates;
    assert.ok(child);
    assert.ok(gate);
    assert.equal(child.killed, false);
    lifecycle.shutdown(); // reaches the in-flight child with no await gap
    assert.equal(child.killed, true);

    gate.resolve(); // let waitReady settle so the (now-stale) start reaches its cancellation check
    await assert.rejects(pending, /whisper-server start cancelled/);
  });

  it("the default spawnServer is synchronous (keeps spawn adjacent to the startingProc handoff)", () => {
    const spawnServer = defaultSpawnServer("/tmp/whisper-models", process.execPath, NOOP_LOGGER);
    const result = spawnServer("base", 45001);
    spawned.push(result);
    assert.ok(result instanceof ChildProcess); // a live child, not a Promise
    assert.equal(typeof result.kill, "function");
  });
});
