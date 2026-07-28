// Host side of the command channel: claim queued commands, run handlers, write
// results back, and announce presence via heartbeat.
//
// Extracted into core from MulmoClaude's server/remoteHost/hostRunner.ts (itself
// ported from ../mulmoserver). The only signature change vs. that copy: the
// `firestore` instance is a parameter (each host supplies its own Firebase init),
// and the heartbeat interval is an option (defaults to one minute).
import {
  DocumentReference,
  Firestore,
  FirestoreError,
  Query,
  QuerySnapshot,
  deleteDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import { errorMessage } from "../../collection/core/errorMessage.js";
import {
  Channel,
  Command,
  CommandHandler,
  CommandHandlers,
  JsonObject,
  buildHostPresence,
  byCreatedAt,
  commandsCollection,
  hostDoc,
  isExpired,
} from "../index.js";
import { stripUndefined, undefinedPaths, unexpectedPaths } from "./firestoreSafeResult.js";

const DEFAULT_HEARTBEAT_MS = 60_000;

// Firestore listen errors worth re-subscribing for (network / backend blips).
// Everything else — permission-denied, unauthenticated, and any unrecognized
// code — is fatal: re-listening can't fix a bad session, and an open-ended retry
// on an unknown code would loop forever.
const TRANSIENT_LISTEN_ERROR_CODES = new Set(["aborted", "cancelled", "deadline-exceeded", "internal", "resource-exhausted", "unavailable"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const listenErrorCode = (error: unknown): string => (isRecord(error) && typeof error.code === "string" ? error.code : "");

export const classifyListenerError = (error: unknown): "transient" | "fatal" =>
  TRANSIENT_LISTEN_ERROR_CODES.has(listenErrorCode(error)) ? "transient" : "fatal";

const BASE_LISTEN_RETRY_MS = 1_000;
const MAX_LISTEN_RETRY_MS = 30_000;
// Bounded transient retries before a listener failure is treated as fatal.
export const MAX_LISTEN_RETRIES = 5;

// Exponential backoff, capped: attempt 0 → 1s, 1 → 2s, … saturating at 30s.
export const backoffDelayMs = (attempt: number): number => Math.min(MAX_LISTEN_RETRY_MS, BASE_LISTEN_RETRY_MS * 2 ** attempt);

export interface HostEvent {
  phase: "received" | "done" | "error";
  method: string;
  message?: string;
}

export interface HostRunnerOptions {
  onEvent?: (event: HostEvent) => void;
  // Called once when the listener dies fatally (after presence has been set
  // offline), so the lifecycle owner can reconcile its own state — e.g. clear
  // the runner handle so status() no longer reports connected. NOT called on a
  // normal stop().
  onClosed?: () => void;
  // Called when a command is dropped for being past its `expiresAt`, BEFORE the
  // doc is deleted, so the host can clean up out-of-band resources the command
  // referenced (e.g. staged attachment uploads in Storage). `uid` is THIS runner's
  // session uid (channel.uid) — passed in rather than read from a global so a
  // concurrent reconnect as a different account can't point cleanup at the wrong
  // user's Storage path. Best-effort: a throw is logged via onEvent and does NOT
  // block the doc deletion. Absent ⇒ the expired doc is simply deleted.
  onExpire?: (command: Command, uid: string) => void | Promise<void>;
  // Presence heartbeat interval; defaults to one minute.
  heartbeatMs?: number;
  // Paths in a handler's reply where `undefined` is expected rather than a bug,
  // keyed by method name — `{ listSessions: ["sessions.*.work"] }`, `*` matching
  // exactly one segment. Firestore refuses `undefined` either way, so these are
  // still stripped; declaring them only silences the report, which is what keeps
  // it worth reading (#2634).
  expectedUndefined?: Record<string, readonly string[]>;
}

interface Claim {
  method: string;
  params: JsonObject;
}

const noop = () => undefined;

// The remote may have deleted the doc on timeout, so ignore write-after-delete.
const writeError = (ref: DocumentReference, code: string, message: string) =>
  updateDoc(ref, { status: "error", error: { code, message }, updatedAt: serverTimestamp() }).catch(noop);

// Atomically move a command queued -> processing so it is handled exactly once.
// Returns the method/params to run, or null if another handler already took it.
const claimCommand = (firestore: Firestore, ref: DocumentReference): Promise<Claim | null> =>
  runTransaction(firestore, async (txn) => {
    const data = (await txn.get(ref)).data() as Command | undefined;
    if (!data || data.status !== "queued") {
      return null;
    }
    txn.update(ref, { status: "processing", updatedAt: serverTimestamp() });
    return { method: data.method, params: data.params ?? {} };
  });

// Own-property lookup: a bare `handlers[method]` with a method name written by a
// remote terminal resolves `constructor` / `toString` to an Object.prototype
// function, which is truthy and slips past the unknown-method check (#2319).
export const resolveCommandHandler = (handlers: CommandHandlers, method: string): CommandHandler | undefined =>
  Object.hasOwn(handlers, method) ? handlers[method] : undefined;

// Firestore refuses a write containing `undefined` at any depth, so one stray
// value would cost the whole reply — `status: "done"` never lands and the remote
// waits out its timeout. Strip instead, and name the paths: Firestore's own error
// points at the document, never at the field, which is where the debugging time
// goes. Paths the caller declared as legitimately-optional are stripped silently.
const reportStripped = (dropped: string[], claim: Claim, options: HostRunnerOptions): void => {
  if (dropped.length === 0) return;
  const paths = dropped.map((path) => `result.${path}`).join(", ");
  options.onEvent?.({ phase: "error", method: claim.method, message: `undefined dropped at ${paths} — Firestore would have refused the whole reply` });
};

const runHandler = async (ref: DocumentReference, claim: Claim, handler: CommandHandler, options: HostRunnerOptions): Promise<HostEvent> => {
  try {
    const returned = await handler(claim.params);
    const dropped = undefinedPaths(returned);
    reportStripped(unexpectedPaths(dropped, options.expectedUndefined?.[claim.method]), claim, options);
    // The walk above already answered "is there anything to strip", so a clean
    // reply — every reply, normally — is written without copying it first.
    await updateDoc(ref, { status: "done", result: dropped.length === 0 ? returned : stripUndefined(returned), updatedAt: serverTimestamp() });
    return { phase: "done", method: claim.method };
  } catch (error) {
    const message = errorMessage(error);
    await writeError(ref, "handler_error", message);
    return { phase: "error", method: claim.method, message };
  }
};

// A command past its deadline is removed entirely rather than run: give the host
// a chance to clean up out-of-band resources (staged attachments), then delete
// the doc so it is neither reprocessed nor left as a stale error. Both steps are
// best-effort/idempotent, so a snapshot replay surfacing the same expired doc
// twice is harmless (no claim transaction needed — see plan edge #3).
const expireCommand = async (ref: DocumentReference, command: Command, options: HostRunnerOptions, uid: string) => {
  try {
    await options.onExpire?.(command, uid);
  } catch (error) {
    options.onEvent?.({ phase: "error", method: command.method, message: `onExpire failed: ${errorMessage(error)}` });
  }
  // Surface a delete failure (permissions / transient network) the same way the
  // onExpire failure above is surfaced — otherwise the expired doc lingers as
  // "queued" with no signal as to why cleanup didn't happen.
  await deleteDoc(ref).catch((error) => {
    options.onEvent?.({ phase: "error", method: command.method, message: `expire delete failed: ${errorMessage(error)}` });
  });
  options.onEvent?.({ phase: "done", method: command.method, message: "expired" });
};

// Per-runner constants bundled into one context so processCommand stays under the
// max-params cap: firestore, the handler table, options, and the session uid are
// all fixed for the runner's lifetime; only ref/command/now vary per command.
interface RunnerContext {
  firestore: Firestore;
  handlers: CommandHandlers;
  options: HostRunnerOptions;
  uid: string;
}

const processCommand = async (ctx: RunnerContext, ref: DocumentReference, command: Command, now: number) => {
  const { handlers, options } = ctx;
  // Drop an expired command before claiming it — it must never reach a handler.
  if (isExpired(command, now)) {
    await expireCommand(ref, command, options, ctx.uid);
    return;
  }
  const claim = await claimCommand(ctx.firestore, ref);
  if (!claim) {
    return;
  }
  options.onEvent?.({ phase: "received", method: claim.method });
  const handler = resolveCommandHandler(handlers, claim.method);
  if (!handler) {
    await writeError(ref, "unknown_method", `No handler for method: ${claim.method}`);
    options.onEvent?.({ phase: "error", method: claim.method, message: "unknown method" });
    return;
  }
  options.onEvent?.(await runHandler(ref, claim, handler, options));
};

// A resilient command listener: its mutable retry state plus the fixed collaborators.
interface ListenerRun {
  queuedCommands: Query;
  ctx: RunnerContext;
  goOffline: () => void;
  stopped: boolean;
  unsubscribe: () => void;
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
}

// Best-effort oldest-first DISPATCH only — commands run concurrently and may
// finish out of order (chat is asynchronous). We sort in memory rather than
// orderBy("createdAt") because a Firestore orderBy silently EXCLUDES docs missing
// the field, dropping every pre-offline-queue command.
const dispatchAddedCommands = (ctx: RunnerContext, snapshot: QuerySnapshot): void => {
  const now = Date.now();
  snapshot
    .docChanges()
    .filter((change) => change.type === "added")
    .map((change) => ({ ref: change.doc.ref, command: change.doc.data() as Command }))
    .sort((left, right) => byCreatedAt(left.command, right.command))
    .forEach(({ ref, command }) => {
      processCommand(ctx, ref, command, now).catch(noop);
    });
};

// Re-subscribe after a transient error, backing off exponentially.
function scheduleResubscribe(run: ListenerRun): void {
  run.retryTimer = setTimeout(() => subscribeCommands(run), backoffDelayMs(run.attempt));
  run.attempt += 1;
}

// A Firestore onSnapshot error terminates THIS listener and never recovers on its
// own. Transient → re-subscribe with bounded backoff (presence stays online);
// fatal, or retries exhausted → go offline.
function handleListenError(run: ListenerRun, error: FirestoreError): void {
  run.ctx.options.onEvent?.({ phase: "error", method: "listen", message: error.message });
  if (run.stopped) return;
  if (classifyListenerError(error) === "fatal" || run.attempt >= MAX_LISTEN_RETRIES) {
    run.goOffline();
    return;
  }
  scheduleResubscribe(run);
}

function subscribeCommands(run: ListenerRun): void {
  run.retryTimer = null;
  if (run.stopped) return;
  run.unsubscribe = onSnapshot(
    run.queuedCommands,
    (snapshot) => {
      run.attempt = 0; // a healthy snapshot proves the listener recovered
      dispatchAddedCommands(run.ctx, snapshot);
    },
    (error) => handleListenError(run, error),
  );
}

// Subscribe to the queued-command stream; re-subscribe on transient listener
// errors with bounded backoff, go offline on a fatal one. Returns a stop that
// cancels any pending retry and detaches the listener.
const listenForCommands = (queuedCommands: Query, ctx: RunnerContext, goOffline: () => void): (() => void) => {
  const run: ListenerRun = { queuedCommands, ctx, goOffline, stopped: false, unsubscribe: noop, retryTimer: null, attempt: 0 };
  subscribeCommands(run);
  return () => {
    run.stopped = true;
    if (run.retryTimer) clearTimeout(run.retryTimer);
    run.unsubscribe();
  };
};

// startHostRunner subscribes to queued commands for the given channel and runs
// each one through the supplied handler table. It also announces presence (a
// heartbeat on users/{uid}/hosts/{hostId}) so the remote can tell it is online.
// Returns a stop function that goes offline and detaches the listener.
export const startHostRunner = (firestore: Firestore, channel: Channel, handlers: CommandHandlers, options: HostRunnerOptions = {}): (() => void) => {
  const presence = hostDoc(firestore, channel);
  // Advertise online/offline + the capability set (method names + protocol
  // version) on the same doc the remote already listens to for presence.
  // Returns void, not the promise: presence is advertised best-effort from
  // three call sites (announce, the snapshot-error path, the teardown), none of
  // which can await. Terminating the chain here with `.catch(noop)` keeps every
  // caller from floating a promise it has no way to handle.
  const writePresence = (online: boolean): void => {
    setDoc(presence, { ...buildHostPresence(channel, handlers, online), updatedAt: serverTimestamp() }).catch(noop);
  };
  const announce = () => {
    writePresence(true);
  };
  announce();
  const beat = setInterval(announce, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  const queuedCommands = query(commandsCollection(firestore, channel), where("status", "==", "queued"));
  const ctx: RunnerContext = { firestore, handlers, options, uid: channel.uid };

  const goOffline = (): void => {
    clearInterval(beat);
    writePresence(false);
    options.onClosed?.();
  };

  const stopListening = listenForCommands(queuedCommands, ctx, goOffline);

  return () => {
    clearInterval(beat);
    writePresence(false);
    stopListening();
  };
};
