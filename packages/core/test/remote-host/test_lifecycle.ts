// Unit tests for the remote-host lifecycle invariants (createRemoteHost):
//   - connect starts a runner and reports connected + uid
//   - connect is NON-DESTRUCTIVE: a failed reconnect leaves the healthy session
//   - connect/disconnect are SERIALIZED: overlapping calls never leak a 2nd runner
//   - disconnect stops the runner + signs out
//   - a FATAL listener death reconciles status() back to disconnected, and the
//     reconciliation is identity-guarded (a superseded runner can't clear a newer one)
//
// The factory takes injected fakes (including a pre-bound startRunner + hostId),
// so these run without Firebase.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRemoteHost, type RemoteHostDeps } from "../../src/remote-host/server/lifecycle.js";
import type { Channel, Command } from "../../src/remote-host/index.js";

const HOST_ID = "test-host";

interface FakeRunner {
  channel: Channel;
  stopped: boolean;
  onClosed?: () => void;
  onExpire?: (command: Command, uid: string) => void | Promise<void>;
  stop: () => void;
}

// Build a lifecycle backed by fakes. signIn maps a token to a uid (and updates
// the "current user"), except the token "bad" which rejects — mirroring
// signInWithCredential leaving currentUser unchanged on failure. An optional
// `onExpire` is forwarded into deps so a test can assert it reaches the runner.
const makeHarness = (onExpire?: RemoteHostDeps["onExpire"]) => {
  const runners: FakeRunner[] = [];
  let uid: string | null = null;
  let signOutCount = 0;

  const startRunner: RemoteHostDeps["startRunner"] = (channel, _handlers, options) => {
    const runner: FakeRunner = { channel, stopped: false, onClosed: options?.onClosed, onExpire: options?.onExpire, stop: () => (runner.stopped = true) };
    runners.push(runner);
    return runner.stop;
  };

  const deps: RemoteHostDeps = {
    hostId: HOST_ID,
    signIn: async (idToken: string) => {
      if (idToken === "bad") throw new Error("rejected credential");
      uid = `uid-${idToken}`;
      return uid;
    },
    signOut: async () => {
      signOutCount += 1;
      uid = null;
    },
    currentUid: () => uid,
    startRunner,
    handlers: {},
    onExpire,
  };

  // A missing runner means the lifecycle under test never started one — fail there, not on a later property read.
  const runnerAt = (index: number): FakeRunner => {
    const runner = runners[index];
    assert.ok(runner, `expected a runner at index ${index}, got ${runners.length}`);
    return runner;
  };

  return { rh: createRemoteHost(deps), runners, runnerAt, signOutCount: () => signOutCount };
};

describe("createRemoteHost lifecycle", () => {
  it("connect starts a runner and reports connected + uid", async () => {
    const { rh, runners, runnerAt } = makeHarness();
    const status = await rh.connect("t1");
    assert.deepEqual(status, { connected: true, uid: "uid-t1" });
    assert.equal(runners.length, 1);
    assert.equal(runnerAt(0).stopped, false);
    assert.deepEqual(runnerAt(0).channel, { uid: "uid-t1", hostId: HOST_ID });
  });

  it("failed reconnect is non-destructive: keeps the existing healthy session", async () => {
    const { rh, runners, runnerAt } = makeHarness();
    await rh.connect("t1");
    await assert.rejects(rh.connect("bad"), /rejected credential/);
    // Old runner still running, no new runner, status unchanged.
    assert.equal(runners.length, 1);
    assert.equal(runnerAt(0).stopped, false);
    assert.deepEqual(rh.status(), { connected: true, uid: "uid-t1" });
  });

  it("serializes overlapping connects: stops the old runner before starting the new", async () => {
    const { rh, runners, runnerAt } = makeHarness();
    const [status1, status2] = await Promise.all([rh.connect("t1"), rh.connect("t2")]);
    assert.equal(runners.length, 2);
    assert.equal(runnerAt(0).stopped, true); // first runner torn down
    assert.equal(runnerAt(1).stopped, false); // second is the live one
    assert.equal(status1.uid, "uid-t1");
    assert.deepEqual(status2, { connected: true, uid: "uid-t2" });
    assert.deepEqual(rh.status(), { connected: true, uid: "uid-t2" });
  });

  it("disconnect stops the runner and signs out", async () => {
    const { rh, runnerAt, signOutCount } = makeHarness();
    await rh.connect("t1");
    const status = await rh.disconnect();
    assert.equal(runnerAt(0).stopped, true);
    assert.equal(signOutCount(), 1);
    assert.deepEqual(status, { connected: false, uid: null });
  });

  it("reconciles status to disconnected when the listener dies fatally", async () => {
    const { rh, runnerAt } = makeHarness();
    await rh.connect("t1");
    assert.equal(rh.status().connected, true);
    // Simulate hostRunner's fatal-listener path invoking onClosed.
    runnerAt(0).onClosed?.();
    assert.equal(rh.status().connected, false);
    // A fresh connect still works after a fatal death.
    await rh.connect("t2");
    assert.deepEqual(rh.status(), { connected: true, uid: "uid-t2" });
  });

  it("threads deps.onExpire into the runner options", async () => {
    const onExpire = () => undefined;
    const { rh, runnerAt } = makeHarness(onExpire);
    await rh.connect("t1");
    assert.equal(runnerAt(0).onExpire, onExpire);
  });

  it("onClosed from a superseded runner does not clear the current one", async () => {
    const { rh, runnerAt } = makeHarness();
    await rh.connect("t1"); // runner 0
    await rh.connect("t2"); // runner 1 (runner 0 stopped)
    runnerAt(0).onClosed?.(); // stale callback from the superseded runner
    assert.deepEqual(rh.status(), { connected: true, uid: "uid-t2" });
    runnerAt(1).onClosed?.(); // the live runner dies
    assert.equal(rh.status().connected, false);
  });
});
