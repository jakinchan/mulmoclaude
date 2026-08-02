#!/usr/bin/env node
// Dev backend supervisor — replaces the bare `tsx server/index.ts` that
// `yarn dev` used to run as its `server` process.
//
// Why: the backend is the only thing listening on the API port; Vite is a
// pure proxy for `/api` + the pubsub socket. So when the backend process
// dies, EVERY client request turns into
//   [vite] http proxy error: /api/... + AggregateError [ECONNREFUSED]
// and — because `yarn dev` runs the two panes under `concurrently -k` —
// the client is SIGTERMed right after and the whole dev session ends. One
// crash mid-session therefore costs a full manual restart.
//
// `server/index.ts` installs uncaughtException / unhandledRejection guards
// (#1364), but those deliberately LOG-AND-EXIT ("the launcher / supervisor
// is responsible for restart"). In dev there was no such supervisor. This
// script is it. It also covers the failures the in-process guards can
// never see: an import-time throw (before the handlers install), an
// explicit `process.exit(1)` from the startup paths, an OOM abort, or a
// native crash inside an in-process generation pipeline.
//
// Deliberately NOT a file watcher: `yarn dev` has never restarted the
// backend on save, and adding that here would be a separate behaviour
// change. This only brings a crashed backend back.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(__dirname);

// A crash sooner than this after boot is a crash LOOP (bad code, a port
// that never frees, a missing build) rather than a one-off runtime fault.
const FAST_CRASH_MS = 5000;
const MIN_DELAY_MS = 300;
const MAX_DELAY_MS = 5000;
// Give up after this many consecutive fast crashes so a permanently
// unbootable backend fails loudly (concurrently -k then tears the client
// down, exactly as before this script existed) instead of respawning
// forever behind a wall of stack traces.
const MAX_FAST_CRASHES = 5;

/**
 * Pure restart policy: given how long the child ran and the crash-loop
 * state so far, decide whether to respawn and after how long.
 * `prevDelayMs` is the previous backoff (`0` on the first crash).
 */
export function restartPlan({ ranForMs, prevDelayMs, fastCrashes }) {
  if (ranForMs >= FAST_CRASH_MS) {
    return { action: "restart", delayMs: MIN_DELAY_MS, fastCrashes: 0 };
  }
  const nextFastCrashes = fastCrashes + 1;
  if (nextFastCrashes >= MAX_FAST_CRASHES) {
    return { action: "giveup", delayMs: 0, fastCrashes: nextFastCrashes };
  }
  const delayMs = Math.min(Math.max(prevDelayMs * 2, MIN_DELAY_MS), MAX_DELAY_MS);
  return { action: "restart", delayMs, fastCrashes: nextFastCrashes };
}

/** How the child ended, for the human-readable restart line. */
export function describeExit(code, signal) {
  return signal ? `signal ${signal}` : `code ${code}`;
}

/**
 * Name the likely cause when the exit itself is the only evidence. V8
 * aborts the process on heap exhaustion, which surfaces here as SIGABRT
 * with no JS stack and no server log line — worth spelling out, since it
 * reads like an unexplained disappearance otherwise.
 */
export function crashHint(signal) {
  if (signal !== "SIGABRT") return "";
  return " — SIGABRT usually means a V8 heap OOM (look for 'FATAL ERROR: ... heap out of memory' above, and for a .heapsnapshot in the repo root)";
}

// Heap settings for the backend child. Every dev crash captured so far
// (11 in four days, `~/Library/Logs/DiagnosticReports/node-*.ips`) is
// `node::OOMErrorHandler` → `V8::FatalProcessOutOfMemory` → abort(), most
// of them while a MulmoScript movie/PDF build ran in-process. An OOM abort
// is NOT a JS exception: no try/catch, no uncaughtException handler, and no
// server log line can see it — hence the "server just vanished" symptom.
//
// Diagnosed cause of the OOMs this supervisor was written for: mulmocast's
// `fileCacheAgentFilter` returned the generated media `buffer` as a GraphAI
// node result. GraphAI retains every node result for the whole run and walks it
// for debug keys; a Buffer is array-like but not an Array, so that walk emitted
// ONE KEY STRING PER BYTE — ~280x expansion, ~115 MB retained per beat, which
// exhausted the default heap around beat 25 of a 68-beat build. Fixed in
// mulmocast 2.9.2 (68 beats now peaks at ~173 MB), which this repo depends on.
//
// So NO heap flags by default. Both of the following are opt-in, for hunting a
// future retainer — deliberately not left on, because a raised ceiling hides
// the next leak and an armed snapshot makes a bad OOM worse (dumping an 8 GB
// heap froze the server ~7 minutes, grew RSS to 21 GB, and wrote a 13 GB file).
const oldSpaceArgs = process.env.DEV_SERVER_MAX_OLD_SPACE_MB ? [`--max-old-space-size=${process.env.DEV_SERVER_MAX_OLD_SPACE_MB}`] : [];
const heapSnapshotArgs = process.env.DEV_SERVER_HEAP_SNAPSHOT === "1" ? ["--heapsnapshot-near-heap-limit=1"] : [];
const heapArgs = [...oldSpaceArgs, ...heapSnapshotArgs];

// DEV_SERVER_ENTRY points the supervisor at a plain .mjs stub (no tsx) —
// used only by its own unit test to drive a child that crashes on boot.
const stubEntry = process.env.DEV_SERVER_ENTRY;
const childArgs = stubEntry
  ? [path.resolve(stubEntry)]
  : [...heapArgs, "--import", "tsx", path.join(REPO_ROOT, "server", "index.ts"), ...process.argv.slice(2)];

function log(msg) {
  console.log(`[dev-server] ${msg}`);
}

const state = { child: null, shuttingDown: false, delayMs: 0, fastCrashes: 0 };

function onChildExit(code, signal, startedAt) {
  state.child = null;
  if (state.shuttingDown) return;
  const ranForMs = Date.now() - startedAt;
  const plan = restartPlan({ ranForMs, prevDelayMs: state.delayMs, fastCrashes: state.fastCrashes });
  state.delayMs = plan.delayMs;
  state.fastCrashes = plan.fastCrashes;
  if (plan.action === "giveup") {
    log(`backend exited (${describeExit(code, signal)}) after ${ranForMs}ms — ${plan.fastCrashes} fast crashes in a row, giving up (see the stack above)`);
    process.exit(1);
  }
  log(`backend exited (${describeExit(code, signal)}) after ${ranForMs}ms — restarting in ${plan.delayMs}ms${crashHint(signal)}`);
  setTimeout(() => {
    if (!state.shuttingDown) start();
  }, plan.delayMs);
}

function start() {
  const startedAt = Date.now();
  state.child = spawn(process.execPath, childArgs, { cwd: REPO_ROOT, stdio: "inherit" });
  state.child.on("exit", (code, signal) => onChildExit(code, signal, startedAt));
  // A spawn that never got off the ground (missing node, bad entry) emits
  // 'error' with no 'exit' — surface it and let the shell see the failure.
  state.child.on("error", (err) => {
    log(`failed to spawn the backend: ${err.message}`);
    process.exit(1);
  });
}

// Forward Ctrl-C / concurrently's teardown to the child so `server/index.ts`
// runs its own graceful shutdown (token cleanup, whisper sidecar) instead of
// being orphaned, and don't treat that exit as a crash. We stay alive until
// the child is gone — once it is, nothing keeps the event loop busy and this
// process ends on its own; the timer is the floor for a child that hangs.
const SHUTDOWN_GRACE_MS = 5000;

function installSignalForwarding() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (state.shuttingDown) return;
      state.shuttingDown = true;
      if (!state.child) process.exit(0);
      state.child.kill(signal);
      setTimeout(() => {
        state.child?.kill("SIGKILL");
        process.exit(0);
      }, SHUTDOWN_GRACE_MS).unref();
    });
  }
}

// Only run when invoked directly. Importing for tests is a no-op.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  installSignalForwarding();
  start();
}
