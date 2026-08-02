// Remote-host command-channel protocol — the browser-safe contract shared by a
// host (MulmoClaude, MulmoTerminal) and the remote/mobile client (mulmoserver).
//
// A host signs in to Firebase as the user, listens to that user's per-host
// command queue in Firestore, runs a handler, and writes the result back; the
// remote writes commands and reads results via a real-time listener. This module
// owns the wire types + the Firestore path helpers. It is the single source of
// truth so the host runner and the client never drift on the protocol.
//
// Ported from ../mulmoserver/src/firestore/commandChannel.ts and the per-host
// copy that lived in MulmoClaude's server/remoteHost/. The one change vs. those
// copies: the path helpers take the `firestore` instance as a parameter (rather
// than importing a module-level singleton) so a single extracted module serves
// every host's own Firebase init. The hostId is host-specific ("mulmoclaude",
// "mulmoterminal") and is supplied by each host — there is no discovery.
import { CollectionReference, DocumentData, DocumentReference, Firestore, collection, doc } from "firebase/firestore";
import { isRecord } from "@mulmoclaude/common";

// JSON payloads carried by the command channel. Explicit JSON types keep the
// channel typed without resorting to any/unknown.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

/** Structural JSON view of `T`, recursively.
 *
 *  TypeScript gives an implicit index signature to type aliases and mapped
 *  types but NOT to interfaces, so a payload assembled from domain interfaces
 *  (`Shortcut`, `FeedSummary`, …) cannot satisfy `Record<string, JsonValue>`
 *  structurally — even though it is plain JSON at runtime. Mapping over `T`
 *  reconstructs it as an anonymous type, which does get that index signature.
 *
 *  Recursive on purpose: a top-level-only map would still leave nested
 *  interfaces (`{ shortcuts: Shortcut[] }`) unassignable, which is the case
 *  every handler here actually has. */
// The function branch must come BEFORE the object branch: a function IS an
// object to TypeScript, so without it a function maps to `{}` and sails
// through — the helper would accept a payload that serialises to nothing.
// Verified: `toJsonObject({ callback: () => undefined })` compiled clean until
// this branch existed (CodeRabbit, #2596).
export type Jsonify<T> = T extends JsonValue
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends (infer U)[]
      ? Jsonify<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonify<T[K]> }
        : never;

/** Widen a JSON-shaped handler payload to the channel's `JsonObject`.
 *
 *  Exists so the `Jsonify` reasoning above lives in ONE place. Before this,
 *  eight remote-host handlers each carried their own `as unknown as JsonObject`
 *  with the justification re-argued in eight slightly different comments —
 *  which is how a rule stops being reviewable. */
export const toJsonObject = <T extends object>(payload: Jsonify<T>): JsonObject => payload as JsonObject;

const describeNonJson = (value: unknown): string => {
  if (typeof value === "number") return String(value);
  if (typeof value === "object") return "a non-plain object";
  return `a ${typeof value}`;
};

/** Anything carrying its own JSON form — `Date` above all — must be asked for
 *  it rather than walked, because walking a `Date`'s own enumerable keys finds
 *  none and flattens the timestamp to `{}`. This is the step `JSON.stringify`
 *  performs before it recurses, and the channel used to get it for free. */
const hasToJson = (value: object): value is { toJSON: () => unknown } => "toJSON" in value && typeof value.toJSON === "function";

const jsonRepresentationOf = (value: object): unknown => (hasToJson(value) ? value.toJSON() : value);

/** Rebuild `value` as JSON, or throw naming the property that cannot be. */
function toJsonValue(value: unknown, path: string): JsonValue {
  if (Array.isArray(value)) return toJsonItems(value, path);
  if (isRecord(value)) {
    const represented = jsonRepresentationOf(value);
    if (represented !== value) return toJsonValue(represented, path);
    return toJsonEntries(value, path);
  }
  return toJsonScalar(value, path);
}

/** JSON's four scalar forms. Anything else — a function, a class instance, a
 *  non-finite number — is what the channel cannot carry. */
function toJsonScalar(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${path} is ${describeNonJson(value)}, which JSON cannot represent`);
}

function toJsonItems(items: unknown[], path: string): JsonValue[] {
  // An absent element becomes `null`, matching `JSON.stringify` — an array has
  // to keep its length, so a hole cannot simply be dropped the way a key is.
  return items.map((entry, index) => (entry === undefined ? null : toJsonValue(entry, `${path}[${index}]`)));
}

function toJsonEntries(record: Record<string, unknown>, path: string): JsonObject {
  const usable = Object.entries(record).filter(([, value]) => value !== undefined);
  return Object.fromEntries(usable.map(([key, value]) => [key, toJsonValue(value, `${path}.${key}`)]));
}

/** Runtime counterpart to `toJsonObject`, for payloads whose values are typed
 *  `unknown` — a collection record, a projected view row — so no amount of
 *  mapped-type work can PROVE them JSON.
 *
 *  Walks the payload and rebuilds it from the values it actually inspected, so
 *  the returned `JsonObject` is earned rather than asserted. Absent (`undefined`)
 *  properties are dropped exactly as `JSON.stringify` drops them; anything the
 *  channel could not carry — a function, a class instance, `NaN` — throws
 *  naming its path, instead of reaching Firestore as a silently mangled write. */
export const coerceJsonObject = (payload: Record<string, unknown>): JsonObject => toJsonEntries(payload, "payload");

// A channel routes commands to one specific host. Both sides agree on a
// hardcoded hostId per use case (e.g. "mulmoclaude", "mulmoterminal"); there is
// no discovery — the remote and host just share the id.
export interface Channel {
  uid: string;
  hostId: string;
}

export type CommandStatus = "queued" | "processing" | "done" | "error";

export interface CommandError {
  code: string;
  message: string;
}

// One document in a channel's commands subcollection is one API-call-like
// request. The remote (mobile) writes method/params; the host writes
// result/error/status.
export interface Command {
  method: string;
  params: JsonObject;
  status: CommandStatus;
  result: JsonValue;
  error: CommandError | null;
  createdBy: "remote" | "host";
  // Offline-queue fields (all optional; absent ⇒ pre-offline-queue behaviour, so
  // this is backward-compatible with every deployed client). Epoch-millisecond
  // NUMBERS set by the remote at enqueue time — deliberately plain numbers, not
  // Firestore Timestamps, so `isExpired` / `byCreatedAt` stay pure + browser-safe
  // and unit-testable without a Firestore fake. Clock skew over a multi-day expiry
  // window is immaterial. See plans/done/feat-remote-offline-queue.md.
  createdAt?: number; // enqueue time — age/display + best-effort dispatch bias (NOT a strict order guarantee; chat is async)
  expiresAt?: number; // deadline; past it the host deletes the command + its staged attachments
  queuedOffline?: boolean; // emitted while the host was offline (gates the remote's attachment rollback)
}

// A command is expired once `now` reaches its remote-set deadline. Absent
// `expiresAt` ⇒ it never expires (pre-offline-queue commands). Pure with an
// injected `now` for deterministic tests; the runner passes `Date.now()`.
export const isExpired = (command: Pick<Command, "expiresAt">, now: number): boolean => typeof command.expiresAt === "number" && now >= command.expiresAt;

// Best-effort dispatch bias for a drained batch: oldest enqueue first. This is
// NOT an ordering guarantee — commands run concurrently and may complete out of
// order (chat is asynchronous, by design); it only nudges which one starts first.
// A command with no `createdAt` sorts as oldest (0) so it is never starved.
export const byCreatedAt = (left: Pick<Command, "createdAt">, right: Pick<Command, "createdAt">): number => (left.createdAt ?? 0) - (right.createdAt ?? 0);

export type CommandHandler = (params: JsonObject) => JsonValue | Promise<JsonValue>;
export type CommandHandlers = Record<string, CommandHandler>;

// Bumped when the command-channel wire protocol changes in a way the remote must
// gate on. Advertised in the presence doc so the remote can check compatibility
// before issuing commands.
//
// v2: offline queueing. The host honours `expiresAt` (deletes an expired command
// + its staged attachments instead of spawning a stale chat). A remote MUST see
// protocolVersion >= 2 before queueing a startChat while the host is offline —
// a v1 host silently ignores `expiresAt`, so a queued chat would spawn stale on
// reconnect with its uploads never cleaned up.
export const REMOTE_HOST_PROTOCOL_VERSION = 2;

// The presence doc's payload: online flag + a capability advertisement. Written
// by the host on every heartbeat; the remote reads it from the presence listener
// it already runs (no extra round trip, known the instant the host is online).
// Browser-safe so the mobile client compiles against the same shape.
// `updatedAt` (a Firestore serverTimestamp) is added by the runner at write time
// and is intentionally not part of this capability contract.
export interface HostPresence {
  online: boolean;
  hostId: string;
  protocolVersion: number;
  // Method names the host serves — the keys of the live handler table.
  capabilities: string[];
}

// Build the presence payload from the live handler table. Capabilities are
// `Object.keys(handlers)` so registering a handler is the ONLY step needed to
// advertise it — there is no second list to keep in sync.
export const buildHostPresence = (channel: Channel, handlers: CommandHandlers, online: boolean): HostPresence => ({
  online,
  hostId: channel.hostId,
  protocolVersion: REMOTE_HOST_PROTOCOL_VERSION,
  capabilities: Object.keys(handlers),
});

// Per-host command queue: users/{uid}/hosts/{hostId}/commands.
export const commandsCollection = (firestore: Firestore, channel: Channel): CollectionReference<DocumentData> =>
  collection(firestore, "users", channel.uid, "hosts", channel.hostId, "commands");

// Presence doc for a host: users/{uid}/hosts/{hostId}. The host heartbeats
// { online, updatedAt } here; the remote reads it to know if the host is up.
export const hostDoc = (firestore: Firestore, channel: Channel): DocumentReference<DocumentData> =>
  doc(firestore, "users", channel.uid, "hosts", channel.hostId);

// Channel health as the resilient runner reports it. Browser-safe alongside the
// wire types because the control that renders it runs in the client.
export { RUNNER_HEALTH_STATES, isRunnerHealth, isRunnerHealthState } from "./health.js";
export type { RunnerHealth, RunnerHealthState } from "./health.js";
