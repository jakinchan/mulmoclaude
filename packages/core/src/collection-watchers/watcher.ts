// Filesystem watchers that drive collection-completion bell
// notifications AND the live-refresh change event. One `fs.watch` per
// discovered collection's `dataDir`, fanned out from a single boot call
// + a 30-second re-discovery interval that catches newly-created /
// deleted collections (there is no in-process "collections changed"
// event broadcast).
//
// Why a watcher, not just route hooks: the canonical pattern for
// collection-skills has the agent Write records directly with the Write
// tool — that path never hits the REST API, so a route-level hook would
// miss most of the traffic the user generates. The watcher catches every
// mutation regardless of who wrote the file.
//
// That same reasoning is why the watcher publishes change events: a
// write through `io.ts` publishes its own (immediately, and reliably
// even where fs.watch is unavailable), but a direct file write has no
// other producer, so open views would never refresh. Both producers
// firing for one `io.ts` write is intentional — the payload carries no
// bodies, so a duplicate costs one redundant refetch, whereas a missed
// event leaves the UI silently stale.
//
// FOUR paths can re-derive a collection's bells, and every backend —
// including read-only `dataSource` — must be covered by all four. They are
// listed because they were NOT: this module grew up when only JSON records
// reconciled, so each path had its own `dataSource` short-circuit, and
// routing every backend through the store contract left the short-circuits
// behind. Three of the four were separate live bugs (PR #2243 review).
//
//   1. mount           — `startWatcherFor`, boot + every remount
//   2. store change    — `handleStoreChange`, the backend reported bytes moved
//   3. schema change   — `reconcileChangedSchemas`, the RULES moved instead
//   4. clock tick      — `tickTimeTriggers`, `triggerField` came due
//
// 3 and 4 are the ones that look skippable and are not: a read-only backend's
// rows never change, but the completion rules applied to them and the wall
// clock both do, and neither produces a data event to react to. Before adding
// a `dataSource` (or any per-backend) early-exit here, check it against all
// four — the surviving ones below are view-refresh publishes, not skips.
//
// SINGLE GENERATION PER PROCESS — the multi-root boundary.
//
// Everything below is module-global: `watchers`, `itemSlots`, `collectionSlots`,
// the rediscovery + trigger timers, `watcherEpoch`, and `discoveryOpts`. So this
// module watches ONE root at a time, and its change payloads all carry that
// root. `startCollectionWatchers` therefore THROWS on a second call naming a
// different root rather than returning quietly, because the quiet version
// leaves that root's direct file writes emitting nothing at all.
//
// Making it genuinely concurrent is deliberately NOT part of the multi-root
// engine change, and it is not the map re-key it looks like. The watcher's maps
// are keyed by slug, but so is the NOTIFICATION identity it drives:
// `reconciler.ts` derives every bell's `legacyId` from `completionLegacyId(slug,
// itemId)`, and the host adapter's `buildNavigateTarget(slug, itemId)` /
// `buildPluginData` take the same pair. Two roots each owning a `tasks`
// collection would collide on the bell, not just on the watcher slot — so
// concurrency requires re-keying a HOST-FACING contract and changing the live
// notification behaviour of a single-workspace host, which this change promises
// not to touch. A multi-root host runs one watcher generation per root process,
// or stops and restarts across roots, until that separate change lands.
//
// All decisions live in `reconciler.ts`; this module is pure plumbing:
// discover, mkdir, fs.watch, forward events into the reconciler. Every
// reconcile call is idempotent so fs.watch's well-known quirks (`rename`
// vs `change`, atomic-write coalescence, filename === null on some
// platforms) don't need special handling.

import { access } from "node:fs/promises";
import {
  collectionChangePayload,
  discoverCollections,
  itemFilePath,
  loadCollection,
  peekWorkspaceRoot,
  publishCollectionChange,
  storeFor,
  type CollectionChangePayload,
  type DiscoveryOptions,
  type LoadedCollection,
  type StoreChange,
} from "../collection/server";
import { errMsg, log } from "./config.js";
import { evalNow } from "./clock.js";
import { reconcileAllItems, reconcileItem, sweepStaleActiveEntries } from "./reconciler.js";

// Collections don't get added / removed rapidly; 30 s is a comfortable
// upper bound on how long a new schema can sit before its watcher is up.
const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;
const REDISCOVERY_INTERVAL_MS = 30 * ONE_SECOND_MS;

// Wall-clock tick that re-reconciles time-dependent collections (those
// declaring `triggerField` and/or `spawn`). The fs.watcher only re-runs
// the reconciler on FILE changes; a `triggerField` bell that should fire
// "when the clock reaches date X" — and a `spawn` whose successor's own
// trigger later comes due — change no file at that moment, so a periodic
// re-derivation is required.
const TRIGGER_TICK_INTERVAL_MS = ONE_MINUTE_MS;

interface CollectionWatcher {
  slug: string;
  dataDir: string;
  /** Unsubscribe from the store's change stream. The store owns HOW changes
   *  are detected (which paths, which filenames are noise, how an atomic
   *  replace is debounced); this module only holds the handle. */
  unsubscribe: () => void;
  /** Last-seen serialized schema, used ONLY as a change-detection
   *  fingerprint. When a rediscovery tick observes a different value, the
   *  watcher's items are reconciled and the cache is refreshed — this catches
   *  schema-only edits (e.g. flipping `completionField` on or off) that don't
   *  touch any record file and would otherwise leave bell state stale
   *  indefinitely. Never parsed back: `collection.schema` below is the same
   *  schema, already typed. */
  schemaJson: string;
  /** The discovered collection this watcher was mounted for — what the
   *  reconciler needs to pick the right STORE (file records vs a sqlite
   *  `storage` db), and the typed schema every other read here goes through.
   *  Refreshed whenever `schemaJson` is. */
  collection: LoadedCollection;
}

const watchers = new Map<string, CollectionWatcher>();
let rediscoveryTimer: ReturnType<typeof setInterval> | null = null;
let triggerTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
/** Guards the clock tick against overlapping itself. Paired with
 *  `watcherEpoch`: a teardown while a pass is in flight bumps the epoch, so
 *  that pass's `finally` knows it belongs to a dead generation and must not
 *  clear a guard the restarted watcher set now owns. `triggerTickInFlight`
 *  is what teardown AWAITS — clearing the flag alone would let a restart run
 *  a second pass alongside the first. */
let triggerTickRunning = false;
let watcherEpoch = 0;
let triggerTickInFlight: Promise<void> | null = null;
/** The boot pass, from before its first await until it settles. This is the
 *  generation CLAIM: `started` flips only at the end of boot, so it cannot by
 *  itself stop two concurrent starts from racing each other's state. Teardown
 *  awaits this too, so a boot in flight can't arm its intervals after the stop
 *  that was meant to disarm them. */
let bootInFlight: Promise<void> | null = null;
/** The root the running (or booting) generation belongs to, NORMALIZED: an
 *  omitted `workspaceRoot` resolves to the host's configured default, so
 *  `start()` and `start({ workspaceRoot: <that same default> })` are the same
 *  generation rather than a spurious conflict. Distinct from
 *  `discoveryOpts.workspaceRoot`, which stays un-normalized because the change
 *  payload's `root` means "an explicit root was passed", not "this root". */
let activeRoot: string | undefined;

/** `err.code` on the conflict throw below: another ROOT's watcher generation is
 *  already up. Distinct from `COLLECTION_ROOT_REQUIRED` (this call forgot its
 *  `workspaceRoot`) because the fixes differ — stop the running generation
 *  versus pass the option — and a host that catches watcher startup in one
 *  fire-and-forget `.catch` should not have to match on message text. */
export const WATCHER_ROOT_CONFLICT = "WATCHER_ROOT_CONFLICT";

/** The root a start request resolves to: its explicit override, else the host's
 *  configured default. `peekWorkspaceRoot` rather than `getWorkspaceRoot` — this
 *  is a comparison, and under an explicit-root binding there is no default to
 *  read, which is not an error here. */
function effectiveRoot(opts: DiscoveryOptions | undefined): string | undefined {
  return opts?.workspaceRoot ?? peekWorkspaceRoot() ?? undefined;
}
/** Discovery options threaded into every `discoverCollections` /
 *  `loadCollection` / `sweepStaleActiveEntries` call. Production: empty
 *  (live workspace). Tests: `{ workspaceRoot, userSkillsDir }` pointing
 *  at a fixture tree. Module-level so per-event handlers can read it
 *  without threading through every signature. */
let discoveryOpts: DiscoveryOptions = {};

/** Per-key single-flight slot (declared here so `stopCollectionWatchers`
 *  can clear it during teardown). */
interface ReconcileSlot {
  running: Promise<void>;
  pending: boolean;
}
const itemSlots = new Map<string, ReconcileSlot>();

/** Per-slug single-flight for a COLLECTION-granularity reconcile — a burst
 *  of changes the store couldn't attribute to a record collapses into one
 *  pass plus one trailing re-run, mirroring the per-item slots. */
const collectionSlots = new Map<string, ReconcileSlot>();

/** Test-only configuration knobs. Production callers pass nothing and get
 *  the live workspace defaults; tests pass a tmpdir-rooted `discoveryOpts`
 *  and override the tick cadences (or set them to `null` to disable the
 *  auto-ticks so the test drives sync manually). */
export interface CollectionWatcherOptions {
  discoveryOpts?: DiscoveryOptions;
  rediscoveryIntervalMs?: number | null;
  triggerTickIntervalMs?: number | null;
}

/** Boot entry point: sweep stale active entries, then mount watchers for
 *  every discovered collection and arm the periodic re-discovery poll.
 *  Idempotent for the SAME root — a second call is a no-op.
 *
 *  A second call for a DIFFERENT root throws. This module holds exactly one
 *  watcher generation per process (see the "single generation" note in the file
 *  header), so silently returning would leave the second root unwatched: direct
 *  file writes there — the canonical agent path — would emit neither
 *  live-refresh events nor completion bells, with nothing anywhere saying so.
 *  That is the same class of silent-wrong-root failure the explicit-root host
 *  binding exists to make loud, so it is loud here too. */
export async function startCollectionWatchers(opts: CollectionWatcherOptions = {}): Promise<void> {
  // Claim the generation SYNCHRONOUSLY. `started` only flips after two awaits,
  // so guarding on it alone lets two concurrent callers both pass, overwrite
  // `discoveryOpts` mid-boot, mount against whichever root won the race, and
  // each arm their own interval — the first of which then escapes teardown,
  // since `rediscoveryTimer` holds only the last handle. `bootInFlight` is set
  // before the first await, so a concurrent caller sees the claim.
  const requested = effectiveRoot(opts.discoveryOpts);
  if (started || bootInFlight !== null) {
    if (requested !== activeRoot) {
      throw Object.assign(
        new Error(
          `@mulmoclaude/core/collection-watchers: watchers are already ${started ? "running" : "starting"} for root ` +
            `${String(activeRoot)}; this process holds one watcher generation, so starting another for ` +
            `${String(requested)} would leave it unwatched. Call stopCollectionWatchers() first, or run one process per root.`,
        ),
        { code: WATCHER_ROOT_CONFLICT },
      );
    }
    // Join the in-flight boot rather than returning early: a same-root caller
    // that returned here while the first pass was still mounting would believe
    // watchers were up before they were.
    await bootInFlight;
    return;
  }
  discoveryOpts = opts.discoveryOpts ?? {};
  activeRoot = requested;
  bootInFlight = bootWatchers(opts);
  try {
    await bootInFlight;
  } finally {
    bootInFlight = null;
  }
}

/** The boot pass itself, owned by exactly one caller — `startCollectionWatchers`
 *  serialises entry into it. On failure it resets `discoveryOpts` so a
 *  supervisor / test harness can retry instead of being permanently latched. */
async function bootWatchers(opts: CollectionWatcherOptions): Promise<void> {
  try {
    // Boot reconcile is split in two: sweep first (drop bell entries whose
    // files / collections / schemas vanished while the server was down),
    // then `syncWatchers` runs the per-collection forward fill. Both paths
    // are idempotent and converge on the same end state.
    await sweepStaleActiveEntries(discoveryOpts);
    await syncWatchers();
    const intervalMs = opts.rediscoveryIntervalMs === undefined ? REDISCOVERY_INTERVAL_MS : opts.rediscoveryIntervalMs;
    if (intervalMs !== null) {
      rediscoveryTimer = setInterval(() => {
        syncWatchers().catch((err: unknown) => {
          log().warn("watcher rediscovery failed", { error: errMsg(err) });
        });
      }, intervalMs);
      // `unref` so a clean process exit isn't blocked waiting for the tick.
      rediscoveryTimer.unref();
    }
    const triggerMs = opts.triggerTickIntervalMs === undefined ? TRIGGER_TICK_INTERVAL_MS : opts.triggerTickIntervalMs;
    if (triggerMs !== null) {
      triggerTimer = setInterval(() => {
        // Skip rather than overlap. The pass is idempotent and the next one
        // is a minute away, so dropping a tick is harmless — whereas letting
        // firings pile up on a slow pass is not.
        if (triggerTickRunning) return;
        triggerTickRunning = true;
        const epoch = watcherEpoch;
        triggerTickInFlight = tickTimeTriggers()
          .catch((err: unknown) => {
            log().warn("watcher trigger tick failed", { error: errMsg(err) });
          })
          .finally(() => {
            // Only the generation that set the guard may clear it.
            if (epoch !== watcherEpoch) return;
            triggerTickRunning = false;
            triggerTickInFlight = null;
          });
      }, triggerMs);
      triggerTimer.unref();
    }
    started = true;
  } catch (err) {
    discoveryOpts = {};
    activeRoot = undefined;
    throw err;
  }
}

/** Tear down every watcher and stop the intervals, and release the root claim
 *  so a subsequent `startCollectionWatchers` may re-mount — for ANY root.
 *
 *  This is a production API, not a test-only one. A single-workspace host never
 *  calls it (process exit reclaims the fds), but since starting a second root
 *  now throws, `stop()` → `start(otherRoot)` is the ONLY way a multi-root host
 *  switches projects. Await it: it waits out a boot still in flight and a clock
 *  pass still running, so the next start does not race the one it replaced. */
export async function stopCollectionWatchers(): Promise<void> {
  // Let a boot in flight finish first. Disarming intervals it has not armed
  // yet would leave them running past the teardown that was meant to stop
  // them. A failed boot is fine to swallow here — we are tearing down anyway.
  await bootInFlight?.catch(() => {});
  if (rediscoveryTimer) {
    clearInterval(rediscoveryTimer);
    rediscoveryTimer = null;
  }
  if (triggerTimer) {
    clearInterval(triggerTimer);
    triggerTimer = null;
  }
  // Wait for a clock pass that is still running: the interval is disarmed
  // above, but a pass already in flight keeps touching the notifier and the
  // slot maps, and a restart would otherwise run a second one beside it.
  await triggerTickInFlight;
  triggerTickInFlight = null;
  // Bump AFTER the await: any later `finally` from that pass is now a dead
  // generation and becomes a no-op, so it can't undo this teardown.
  watcherEpoch += 1;
  triggerTickRunning = false;
  for (const watcher of watchers.values()) {
    try {
      watcher.unsubscribe();
    } catch {
      /* unsubscribe is best-effort */
    }
  }
  watchers.clear();
  itemSlots.clear();
  collectionSlots.clear();
  discoveryOpts = {};
  activeRoot = undefined;
  started = false;
}

/** Test-only: manually trigger one rediscovery + reconcile pass. */
export async function _syncWatchersForTesting(): Promise<boolean> {
  return syncWatchers();
}

/** Test-only: drive one wall-clock tick synchronously, with an optional
 *  injected clock. */
export async function _tickTimeTriggersForTesting(now?: Date): Promise<void> {
  await tickTimeTriggers(now);
}

/** Re-reconcile every watched collection that depends on the clock — i.e.
 *  declares `triggerField` (a bell that fires at a date) and/or `spawn`
 *  (recurrence whose successors come due over time). Collections with
 *  neither are skipped. Idempotent. Reads the watcher's cached
 *  `collection.schema` to avoid a per-tick disk read. */
async function tickTimeTriggers(now: Date = evalNow()): Promise<void> {
  for (const entry of watchers.values()) {
    const { schema } = entry.collection;
    // dataSource is NOT excluded. Its rows are read-only, but `triggerField`
    // is not among the keys zod forbids on it, and a trigger date fires from
    // the CLOCK — the one state change that arrives without the file moving.
    // Skipping it here left CSV rows that were pending-but-not-yet-due unable
    // to ever bell unless the file happened to be rewritten.
    if (!schema.triggerField && !schema.spawn) continue;
    await reconcileAllItems(entry.collection, discoveryOpts, now);
  }
}

/** Reconcile the watcher set against the currently-discovered
 *  collections. Adds watchers for new slugs (with a boot reconcile of
 *  their items), drops watchers for vanished slugs, and re-reconciles
 *  items for collections whose schema changed. Runs a final sweep when
 *  this tick changed the watcher set or any schema. */
async function syncWatchers(): Promise<boolean> {
  let collections;
  try {
    collections = await discoverCollections(discoveryOpts);
  } catch (err) {
    log().warn("watcher discover failed", { error: errMsg(err) });
    return false;
  }
  const liveSlugs = new Set(collections.map((collection) => collection.slug));
  const vanishedMutated = stopVanishedWatchers(liveSlugs);
  const schemaMutated = await reconcileChangedSchemas(collections);
  const addedMutated = await startNewWatchers(collections);
  if (!vanishedMutated && !schemaMutated && !addedMutated) return false;
  await sweepStaleActiveEntries(discoveryOpts);
  return true;
}

function stopVanishedWatchers(liveSlugs: Set<string>): boolean {
  let mutated = false;
  for (const slug of [...watchers.keys()]) {
    if (liveSlugs.has(slug)) continue;
    const watcher = watchers.get(slug);
    if (watcher) {
      try {
        watcher.unsubscribe();
      } catch {
        /* best-effort */
      }
    }
    watchers.delete(slug);
    mutated = true;
    log().info("watcher stopped", { slug });
  }
  return mutated;
}

/** True when a schema edit moved the collection's storage — a different
 *  `dataSource.path`, a different `dataPath`, or a flip between the two
 *  modes. The mounted fs.watch is bound to the OLD location, so it must
 *  be remounted, not just re-reconciled. */
function storagePathChanged(previous: LoadedCollection["schema"], next: LoadedCollection["schema"]): boolean {
  return previous.dataSource?.path !== next.dataSource?.path || previous.dataPath !== next.dataPath || previous.storage?.path !== next.storage?.path;
}

/** Re-reconcile already-watched collections whose schema changed since
 *  the last tick. New collections fall through to `startNewWatchers`. */
async function reconcileChangedSchemas(collections: readonly LoadedCollection[]): Promise<boolean> {
  let mutated = false;
  for (const collection of collections) {
    const existing = watchers.get(collection.slug);
    if (!existing) continue;
    const nextJson = JSON.stringify(collection.schema);
    if (existing.schemaJson === nextJson) continue;
    if (storagePathChanged(existing.collection.schema, collection.schema)) {
      // Drop the stale mount; `startNewWatchers` (which runs right after
      // this pass in syncWatchers) remounts on the new location. A
      // dataSource collection also gets a change ping so open views
      // refetch against the new file immediately.
      log().info("watcher storage path changed, remounting", { slug: collection.slug });
      try {
        existing.unsubscribe();
      } catch {
        /* best-effort */
      }
      watchers.delete(collection.slug);
      if (collection.schema.dataSource !== undefined) safePublish({ slug: collection.slug, op: "upsert" });
      mutated = true;
      continue;
    }
    existing.schemaJson = nextJson;
    existing.collection = collection;
    log().info("watcher schema changed, re-reconciling", { slug: collection.slug });
    // Completion rules live in the SCHEMA, so a schema-only edit can change
    // which items are pending without any record changing. This runs for
    // every backend including dataSource: those rows are read-only, but the
    // rules applied to them are not. Re-deriving no-ops unless the schema
    // declares `completionField`; a completionField that was REMOVED is the
    // sweep's job, which `mutated` schedules at the end of the tick.
    await reconcileAllItems(collection, discoveryOpts);
    if (collection.schema.dataSource !== undefined) {
      // Read-only rows can't have changed, but a schema edit changes what the
      // views render (fields, displayField, …), so ping them.
      safePublish({ slug: collection.slug, op: "upsert" });
    }
    mutated = true;
  }
  return mutated;
}

/** Mount a watcher for every collection that doesn't have one yet. Returns
 *  whether the watcher SET actually changed — the starters report whether
 *  they mounted, because ATTEMPTING is not mounting. A start that throws
 *  (logged and swallowed inside the starter) leaves `watchers` untouched, so
 *  the collection is retried next tick; counting that as a mutation made
 *  `syncWatchers` sweep on every tick for as long as the failure persisted. */
async function startNewWatchers(collections: readonly LoadedCollection[]): Promise<boolean> {
  let mutated = false;
  for (const collection of collections) {
    if (watchers.has(collection.slug)) continue;
    if (await startWatcherFor(collection)) mutated = true;
  }
  return mutated;
}

/** Mount one collection's change subscription, whatever its backend.
 *
 *  The store decides how to detect a change and at what granularity; this
 *  decides what to do about one. That split is the point: adding a backend
 *  means implementing `watch` on its store, not another branch here.
 *
 *  A store without `watch` cannot report external changes at all — it is
 *  still registered (so bells reconcile at boot and on the clock tick), just
 *  without live updates. */
async function startWatcherFor(collection: LoadedCollection): Promise<boolean> {
  const { slug } = collection;
  try {
    // Boot reconcile BEFORE subscribing: an item that went pending while the
    // server was down needs its bell even if no event ever fires.
    await reconcileAllItems(collection, discoveryOpts);
    const store = storeFor(collection, discoveryOpts);
    const unsubscribe = store.watch
      ? await store.watch((change) => {
          void handleStoreChange(slug, change).catch((err: unknown) => {
            log().warn("store change handling failed", { slug, error: errMsg(err) });
          });
        })
      : () => {};
    // `null` means the backend HAS a watch but could not arm it this time.
    // Registering anyway would mark the slug mounted forever: `startNewWatchers`
    // skips slugs already in `watchers`, so nothing would re-arm it and the
    // collection would serve stale data until a restart. Leave it out and the
    // next sync tick retries — the boot reconcile above is idempotent.
    if (unsubscribe === null) {
      log().warn("collection watcher could not arm, retrying next sync", { slug });
      return false;
    }
    watchers.set(slug, { slug, dataDir: collection.dataDir, unsubscribe, schemaJson: JSON.stringify(collection.schema), collection });
    log().info("collection watcher started", { slug, live: store.watch !== undefined });
    return true;
  } catch (err) {
    log().warn("collection watcher start failed", { slug, error: errMsg(err) });
    return false;
  }
}

/** React to one reported change. Backend-agnostic by construction — it sees
 *  only the granularity the store reported.
 *
 *  `item`: reconcile just that record, then publish it. `collection`: the
 *  store couldn't say which record, so re-derive everything and pair it with
 *  a sweep — a record deleted remotely leaves a bell that a walk over the
 *  SURVIVING records can never clear. */
async function handleStoreChange(slug: string, change: StoreChange): Promise<void> {
  if (change.kind === "collection") {
    await scheduleCollectionReconcile(slug);
    return;
  }
  // Resolve the collection at EVENT time, not at mount time. A schema-only
  // edit (one that leaves the storage location alone, so nothing remounts)
  // refreshes `watchers`' entry in place — a callback closed over the mount-
  // time snapshot would keep reconciling against the old `completionField` /
  // `notifyWhen` / `triggerField` and undo what the schema-change pass had
  // just converged on.
  const current = watchers.get(slug)?.collection;
  if (!current) return; // unmounted between the event and now
  await scheduleItemReconcile(current, change.itemId);
}

/** Full re-derivation for a collection-granularity change, single-flighted
 *  per slug so a burst of writes collapses into one pass plus one trailing
 *  re-run. */
function scheduleCollectionReconcile(slug: string): Promise<void> {
  return runSingleFlight(
    collectionSlots,
    slug,
    async () => {
      const collection = await loadCollection(slug, discoveryOpts);
      if (!collection) return;
      await reconcileAllItems(collection, discoveryOpts);
      // A record deleted underneath us leaves a bell that a walk over the
      // SURVIVING records can never clear — the sweep is the other half.
      await sweepStaleActiveEntries(discoveryOpts);
    },
    // Publish from `onSettled`, i.e. even when the pass above threw: the
    // data changed regardless of whether we managed to re-derive bells from
    // it, and a missed event leaves every open view silently stale. The slot
    // is the coalescing unit, so one burst still yields one publish.
    () => {
      safePublish({ slug, op: "upsert" });
      return Promise.resolve();
    },
  );
}

/** Test-only: feed one store-reported change through the same path a live
 *  subscription uses, so a test can pin how a change is reacted to without
 *  depending on fs.watch timing. */
export function _handleStoreChangeForTesting(slug: string, change: StoreChange): Promise<void> {
  return handleStoreChange(slug, change);
}

/** Test-only: drive one collection-granularity reconcile directly. */
export function _scheduleCollectionReconcileForTesting(slug: string): Promise<void> {
  return scheduleCollectionReconcile(slug);
}

export function _scheduleItemReconcileForTesting(collection: LoadedCollection, itemId: string): Promise<void> {
  return scheduleItemReconcile(collection, itemId);
}

function scheduleItemReconcile(collection: LoadedCollection, itemId: string): Promise<void> {
  return runSingleFlight(
    itemSlots,
    `${collection.slug}\x00${itemId}`,
    () => reconcileItem(collection, itemId, discoveryOpts),
    () => publishItemChange(collection, itemId),
  );
}

/** The shared single-flight loop behind both schedulers. Re-runs `pass`
 *  while events keep arriving — the trailing re-run captures any state
 *  change that landed during a prior pass. After each pass we read
 *  `pending` and zero it before the next iteration, so an event that
 *  fires *during* the last pass's await still triggers one more pass
 *  before the slot is freed. `onSettled`, if given, runs once in the
 *  `finally` after the slot is freed — the item scheduler uses it to
 *  publish exactly one live-refresh event per burst. */
function runSingleFlight(slots: Map<string, ReconcileSlot>, key: string, pass: () => Promise<void>, onSettled?: () => Promise<void>): Promise<void> {
  const existing = slots.get(key);
  if (existing) {
    existing.pending = true;
    return existing.running;
  }
  const slot: ReconcileSlot = { running: Promise.resolve(), pending: false };
  slot.running = (async () => {
    try {
      let keepGoing = true;
      while (keepGoing) {
        slot.pending = false;
        await pass();
        keepGoing = slot.pending;
      }
    } finally {
      slots.delete(key);
      // `onSettled` runs once after the slot is freed — the slot is the
      // coalescing primitive, so one burst yields one call. It's in the
      // `finally` because a failed reconcile still means a file changed,
      // and open views must be told to refetch either way.
      if (onSettled) await onSettled();
    }
  })();
  slots.set(key, slot);
  return slot.running;
}

/** Emit the live-refresh event for one record. `op` is derived from
 *  whether the file is still there — `fs.watch` reports neither the kind
 *  of change nor, reliably, which of `rename`/`change` means what. Only
 *  file-backed collections reach here; a `storage` (db) collection has no
 *  per-record file and publishes wholesale in `scheduleStorageReconcile`. */
async function publishItemChange(collection: LoadedCollection, itemId: string): Promise<void> {
  const changeOp = (await itemFileExists(collection.dataDir, itemId)) ? "upsert" : "delete";
  safePublish({ slug: collection.slug, ids: [itemId], op: changeOp });
}

async function itemFileExists(dataDir: string, itemId: string): Promise<boolean> {
  try {
    await access(itemFilePath(dataDir, itemId));
    return true;
  } catch {
    return false;
  }
}

/** The publisher is host-supplied, so treat it as untrusted: a throw here
 *  runs inside a `finally` and would mask the reconcile's own error.
 *
 *  Stamps the root the watcher is RUNNING for (`discoveryOpts.workspaceRoot`)
 *  rather than deriving one from `collection.dataDir` — a `LoadedCollection`
 *  carries only absolute paths, and a root reconstructed by string surgery
 *  would be a guess. Undefined in a single-workspace host, which is exactly
 *  what the payload contract means by "the host's configured root". */
function safePublish(payload: Omit<CollectionChangePayload, "root">): void {
  const enriched = collectionChangePayload(payload, discoveryOpts.workspaceRoot);
  try {
    publishCollectionChange(enriched);
  } catch (err) {
    log().warn("collection change publish failed", { slug: enriched.slug, error: errMsg(err) });
  }
}
