// Unit tests for the popup-free reconnect path (createRemoteHost + deps.restore,
// mulmoserver#50 case A'):
//   - reconnect restores a session and starts the runner (connected + uid)
//   - reconnect is NON-DESTRUCTIVE: a failed restore leaves a healthy session
//   - reconnect without a `restore` dep rejects with a clear error
//   - reconnect/connect are SERIALIZED: overlap never leaks a 2nd runner
//
// Backed by injected fakes (a `restore` that maps a blob to a uid, plus a
// pre-bound startRunner), so these run without Firebase.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRemoteHost, type RemoteHostDeps } from "../../src/remote-host/server/lifecycle.js";
import type { Channel } from "../../src/remote-host/index.js";

const HOST_ID = "test-host";

interface FakeRunner {
  channel: Channel;
  stopped: boolean;
  stop: () => void;
}

// blob "bad-blob" rejects (mirrors an expired/invalid parked session); any other
// blob restores to `uid-<blob>`. `withRestore: false` omits the dep entirely.
const makeHarness = (opts: { withRestore?: boolean } = {}) => {
  const runners: FakeRunner[] = [];
  let uid: string | null = null;

  const startRunner: RemoteHostDeps["startRunner"] = (channel) => {
    const runner: FakeRunner = { channel, stopped: false, stop: () => (runner.stopped = true) };
    runners.push(runner);
    return runner.stop;
  };

  const deps: RemoteHostDeps = {
    hostId: HOST_ID,
    signIn: async (idToken) => {
      uid = `uid-${idToken}`;
      return uid;
    },
    ...(opts.withRestore === false
      ? {}
      : {
          restore: async (blob) => {
            if (blob === "bad-blob") throw new Error("blob expired");
            uid = `uid-${blob}`;
            return uid;
          },
        }),
    signOut: async () => {
      uid = null;
    },
    currentUid: () => uid,
    startRunner,
    handlers: {},
  };

  return { host: createRemoteHost(deps), runners, liveRunners: () => runners.filter((runner) => !runner.stopped) };
};

describe("remote-host reconnect (case A')", () => {
  it("restores a parked session and starts the runner", async () => {
    const { host, liveRunners } = makeHarness();
    const status = await host.reconnect("sessionA");
    assert.deepEqual(status, { connected: true, uid: "uid-sessionA" });
    assert.equal(liveRunners().length, 1);
    const [live] = liveRunners();
    assert.ok(live);
    assert.equal(live.channel.uid, "uid-sessionA");
    assert.equal(live.channel.hostId, HOST_ID);
  });

  it("is non-destructive: a failed restore leaves the existing session running", async () => {
    const { host, liveRunners } = makeHarness();
    await host.reconnect("sessionA");
    const [before] = liveRunners();

    await assert.rejects(host.reconnect("bad-blob"), /blob expired/);

    const after = liveRunners();
    assert.equal(after.length, 1);
    assert.equal(after[0], before, "the healthy runner must not be torn down");
    assert.deepEqual(host.status(), { connected: true, uid: "uid-sessionA" });
  });

  it("replaces a running session on a successful reconnect (single-runner invariant)", async () => {
    const { host, liveRunners } = makeHarness();
    await host.connect("tokenX");
    await host.reconnect("sessionB");
    assert.equal(liveRunners().length, 1);
    const [live] = liveRunners();
    assert.ok(live);
    assert.equal(live.channel.uid, "uid-sessionB");
  });

  it("rejects when no restore dependency is wired", async () => {
    const { host, liveRunners } = makeHarness({ withRestore: false });
    await assert.rejects(host.reconnect("sessionA"), /requires a `restore` dependency/);
    assert.equal(liveRunners().length, 0);
  });

  it("serializes overlapping connect + reconnect without leaking a second runner", async () => {
    const { host, liveRunners } = makeHarness();
    await Promise.all([host.connect("tokenX"), host.reconnect("sessionA")]);
    assert.equal(liveRunners().length, 1, "exactly one runner survives");
  });
});
