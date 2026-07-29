// Remote-host lifecycle for this host: bind MulmoClaude's Firebase deps + hostId
// to the shared `createRemoteHost` factory so connecting from the toolbar starts
// the Firestore command loop + presence heartbeat, and disconnecting stops both.
//
// The transport engine (command loop, connect/disconnect invariants, Firebase
// init/auth) lives in `@mulmoclaude/core/remote-host/server`; this module only
// supplies host specifics — hostId, the handler table, the firestore-bound
// runner, and a logger adapter — and exposes the default singleton the route uses.
//
// Single-account, single-host (HOST_ID = "mulmoclaude"). The Firebase session is
// parked in the browser (case A', mulmoserver#50), so a server restart doesn't
// force a re-login: the client reconnects from its stored blob.
import { createRemoteHost, presenceStaleAfterMs, startHostRunner, type HostRunnerOptions } from "@mulmoclaude/core/remote-host/server";
import type { Channel, CommandHandlers } from "@mulmoclaude/core/remote-host";

import { log } from "../system/logger/index.js";
import { HOST_ID } from "./commandChannel.js";
import { currentFirestore, currentUid, restore, signIn, signOut } from "./session.js";
import { handlers } from "./handlers/index.js";
import { onExpire } from "./onExpire.js";
import { createPresenceProbe } from "./presenceProbe.js";
import { startResilientRunner } from "./resilientRunner.js";

export type { RemoteHostStatus } from "@mulmoclaude/core/remote-host/server";
export { exportSession, RemoteHostSessionExpiredError } from "./session.js";

const PREFIX = "remote-host";

const hostLog = {
  info: (msg: string) => log.info(PREFIX, msg),
  warn: (msg: string) => log.warn(PREFIX, msg),
  debug: (msg: string) => log.debug(PREFIX, msg),
};

// The command channel, wrapped in the recovery ring that outlives a single runner
// (#2633): core re-subscribes in place and gives up after minutes, this relaunches
// the whole runner, and only when that stops helping does `onClosed` reach the
// lifecycle — which is what makes the client re-auth from its parked blob.
const startRunner = (channel: Channel, hostHandlers: CommandHandlers, options: HostRunnerOptions): (() => void) =>
  startResilientRunner({
    start: (runnerOptions) => startHostRunner(currentFirestore(), channel, hostHandlers, runnerOptions),
    options,
    // The probe judges freshness against the SAME threshold the runner beats on —
    // derived from the options it is about to run with, so a custom `heartbeatMs`
    // can never leave the two applying different rules.
    checkAlive: createPresenceProbe({ firestore: currentFirestore, channel, staleAfterMs: presenceStaleAfterMs(options) }),
    log: hostLog,
  });

// Default singleton wired to the session-backed Firebase deps — imported by the
// route. The runner reads the CURRENT session's firestore (it changes each
// (re)connect); the logger adapts the factory's plain-string calls to the host
// logger's (prefix, msg) shape.
const instance = createRemoteHost({
  hostId: HOST_ID,
  signIn,
  restore,
  signOut,
  currentUid,
  startRunner,
  handlers,
  onExpire,
  log: hostLog,
});

export const { connect, reconnect, disconnect, status } = instance;
