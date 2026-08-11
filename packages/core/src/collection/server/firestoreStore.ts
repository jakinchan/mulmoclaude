// The Firestore store: a SHARED collection's records as Firestore documents.
//
// Documents live at `apps/{aid}/collections/{cid}/items/{id}`. The identity is
// `(aid, cid)`: `aid` comes from the repository's committed `app.json` and is
// resolved once by discovery (`LoadedCollection.appId`), `cid` is always the
// collection's slug. Nothing here reads a file or a session to work out WHERE —
// it is handed a settled identity and builds the path from it.
//
// WHAT PROTECTS THESE DOCUMENTS. Not the shape of the path. An earlier draft of
// this backend wrote under `users/{uid}/…` and leaned on the deployed rule
// `users/{uid}/{document=**}`, so "the schema cannot name a path" WAS the
// safety argument. It no longer is, and reading it that way would be a lie: an
// `aid` is committed in a repository that anyone with a clone can edit. What
// authorizes a read or a write is the app's MEMBER ROSTER — the rules resolve
// `request.auth.token.email` against `apps/{aid}.members` and derive a role per
// collection. Pointing at another app's `aid` is not an escape; it is a request
// that gets refused, by name, for a caller who is not on that roster.
//
// The schema still declares no path, but for a different reason: there is
// nothing for it to say. `aid` is one per app (four collections share one
// roster), and `cid` is the slug. See `StorageZ`'s firestore arm.
//
// Availability: the authenticated handle belongs to the host's remote-host
// session, so a shared collection is readable/writable only while that session
// is open. This follows sqliteStore's precedent for an unavailable engine — the
// FACTORY never throws (`storeFor` is called from ontology/validate/routes and
// must not break unrelated screens), each METHOD fails with an actionable
// message instead. It must never degrade to an empty result: "no records" and
// "not connected" have to stay distinguishable, or a disconnected session looks
// like data loss.
//
// SDK access goes through the `FirestoreDocs` seam (firestoreDocs.ts), not the
// modular functions directly — that is what makes the backend testable without
// a live Firestore.
//
// No `query`: there is no Firestore analogue of the DuckDB aggregation the CSV
// store exposes. Absent `query` is a supported state — the engine-level
// fallback (`runCollectionQuery`) answers aggregations instead.

import { isRecord } from "@mulmoclaude/common";
import { sharedCollectionKey, type SharedCollectionKey } from "../core/collectionKey";
import type { CollectionItem } from "../core/schema";
import { BackendUnavailableError } from "./backendAvailability";
import type { LoadedCollection } from "./discoveredCollection";
import { firestoreHandle, publishCollectionChange, sharedCollectionChangePayload, type FirestoreHandle } from "./host";
import type { DeleteItemResult, IoOptions, WriteItemResult } from "./io";
import { safeRecordId } from "./paths";
import { projectItemFields, type ListOptions, type ListPage, type WriteOptions } from "./storePage";
import type { CollectionStore } from "./store";

/** What every operation throws when there is no live session. Worded as an
 *  instruction because it surfaces straight to the user and the agent. */
const NOT_CONNECTED =
  "shared collection unavailable: connect remote-host first — these records live in the app's Firestore, not in the workspace, so nothing can be read or written while the session is closed";

/** What a schema declaring `storage.type: "firestore"` must have had resolved
 *  for it before it can be served. Its absence is a programming error here, not
 *  a user-facing state: discovery REFUSES such a schema when the repository
 *  declares no `aid`, so a collection that reached this store has one. */
const NO_APP = "shared collection has no app id — discovery should have refused this schema; check that the repository's app.json declares an `aid`";

/** The records subcollection of one shared collection.
 *
 *  Takes a KEY, never loose strings, and the key is the only way to reach this
 *  function. `sharedCollectionKey` is where the name rule lives (the charset a
 *  Firestore document id, a pubsub channel segment and the completion-bell id
 *  must all survive), so building a path cannot be a way around it. */
export function sharedItemsPath(key: SharedCollectionKey): string {
  return `apps/${key.aid}/collections/${key.cid}/items`;
}

/** The collection's identity, from what discovery resolved. Throws on a
 *  missing `appId` — see NO_APP. */
function keyOf(collection: Pick<LoadedCollection, "slug" | "appId">): SharedCollectionKey {
  if (collection.appId === undefined) throw new Error(NO_APP);
  // `cid` IS the slug. Fixed here, deliberately, rather than made configurable:
  // the schema, the views and the skill text sit in a directory named by the
  // slug, so a second name would need a mapping table between what a collection
  // is called on disk and what it is called in its app — two names for one
  // thing, which is the exact collision `CollectionKey` exists to remove.
  return sharedCollectionKey(collection.appId, collection.slug);
}

function requireHandle(): FirestoreHandle {
  const handle = firestoreHandle();
  if (handle === null) throw new BackendUnavailableError(NOT_CONNECTED);
  return handle;
}

/** Firestore's own refusal, named.
 *
 *  `permission-denied` is the failure a shared collection has most often and
 *  the one the SDK explains worst ("Missing or insufficient permissions") — it
 *  says nothing about WHO was refused, which is the only fact that leads to a
 *  fix. Authorization here is the app's member roster, keyed by email, so the
 *  signed-in address is what the app's owner needs in order to add it. This is
 *  the whole reason `FirestoreHandle` carries `email`.
 *
 *  Reported as a `BackendUnavailableError` deliberately, even though it is a
 *  refusal rather than an outage: the layers above catch broadly, and without a
 *  type to test, `store.read(...).catch(() => null)` reports "record missing"
 *  and an ontology count reports 0 — a denial would read as an empty
 *  collection, which is the exact confusion this backend refuses to create. */
function isPermissionDenied(err: unknown): boolean {
  return isRecord(err) && err.code === "permission-denied";
}

function deniedMessage(key: SharedCollectionKey, email: string): string {
  return `permission denied on shared collection '${key.cid}' of app '${key.aid}' — signed in as ${email}. A shared collection is authorized by the app's member roster (by email), so this address needs a role for '${key.cid}' (or '*'); only the app's owner can add it.`;
}

/** Run one SDK call, translating a roster denial. Every read and write goes
 *  through this — a denial reaching one path and not another would mean the
 *  message a user sees depends on which screen they were on. */
async function guarded<T>(key: SharedCollectionKey, email: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
    throw new BackendUnavailableError(deniedMessage(key, email));
  }
}

/** A stored document's fields → a record. A document written by hand (or by an
 *  older version) can hold anything, so a non-object is dropped rather than
 *  surfaced as a broken record — the same fail-soft the file store applies to
 *  an unparseable `.json`. */
/** A stored document as a record — with its identity taken from the DOCUMENT
 *  ID, never from the document's own fields.
 *
 *  This is the one place a shared record's identity is decided, and it is
 *  decided against the field the writer supplied on purpose.
 *
 *  The rules can constrain the document id (`idFrom` pins it to the
 *  submitter's uid, or to uid+field) and they CANNOT constrain the value of a
 *  field: `validateOk` checks which keys are present, `keyFieldsOk` checks a
 *  declared enum, and nothing compares `request.resource.data[primaryKey]`
 *  with the path being written. So a public submitter writing at their one
 *  permitted document id could put ANY value in the primary-key field —
 *  another member's record id, or a duplicate — and every reader would take it
 *  as the record's identity. Overwriting it here makes that unreachable rather
 *  than merely discouraged, and it costs nothing: for a record written through
 *  this store the two already agree, because `firestoreWrite` writes at the id
 *  it was given.
 *
 *  It also removes the reason a submit path would have had to accept the
 *  primary key as a `createField` at all — a submission that cannot name its
 *  own id is exactly right when the id is the thing being assigned. */
function toItem(data: unknown, docId: string, primaryKey: string): CollectionItem | null {
  return isRecord(data) ? { ...data, [primaryKey]: docId } : null;
}

/** Record ids are validated with the SAME helper every other backend uses.
 *  Firestore would accept ids the file store refuses, but a record should stay
 *  portable between backends — and an id that can't round-trip to a filename
 *  would break an export back to a file collection. */
function withSafeId<T>(itemId: string, onInvalid: () => T, run: (safeId: string, handle: FirestoreHandle) => T): T {
  const safeId = safeRecordId(itemId);
  if (safeId === null) return onInvalid();
  return run(safeId, requireHandle());
}

async function firestoreList(key: SharedCollectionKey, primaryKey: string): Promise<CollectionItem[]> {
  const { docs, email } = requireHandle();
  const entries = await guarded(key, email, () => docs.list(sharedItemsPath(key)));
  return entries.map((entry) => toItem(entry.data, entry.id, primaryKey)).filter((item): item is CollectionItem => item !== null);
}

/** Paging is emulated over a full ordered read rather than pushed into
 *  Firestore: `offset` has no server-side form there (the cursor API needs the
 *  preceding document, which a stateless offset/limit call doesn't have), and
 *  `total` needs the full count anyway. Hence `nativePaging: false` — the
 *  capability is honest about the cost. */
async function firestorePage(key: SharedCollectionKey, primaryKey: string, opts: ListOptions): Promise<ListPage> {
  const items = await firestoreList(key, primaryKey);
  const offset = Math.max(0, opts.offset ?? 0);
  const sliced = opts.limit === undefined ? items.slice(offset) : items.slice(offset, offset + Math.max(0, opts.limit));
  return { items: projectItemFields(sliced, opts.fields, primaryKey), total: items.length, truncated: false };
}

async function firestoreRead(key: SharedCollectionKey, itemId: string, primaryKey: string): Promise<CollectionItem | null> {
  return withSafeId(
    itemId,
    () => Promise.resolve(null),
    async (safeId, { docs, email }) => toItem(await guarded(key, email, () => docs.get(sharedItemsPath(key), safeId)), safeId, primaryKey),
  );
}

/** Publish the "records changed" ping for a shared collection.
 *
 *  `sharedCollectionChangePayload` NEVER stamps a root, and that matters beyond
 *  tidiness: this payload is relayed to the browser and on into an
 *  LLM-generated custom-view iframe, so a filesystem path on it would be a
 *  disclosure. The type makes it unreachable rather than trusting the caller. */
function publishShared(key: SharedCollectionKey, ids: string[], operation: "upsert" | "delete"): void {
  publishCollectionChange(sharedCollectionChangePayload({ slug: key.cid, ids, op: operation }, key.aid));
}

async function firestoreWrite(
  key: SharedCollectionKey,
  itemId: string,
  item: CollectionItem,
  opts: IoOptions & { refuseOverwrite?: boolean | undefined },
): Promise<WriteItemResult> {
  return withSafeId<Promise<WriteItemResult>>(
    itemId,
    () => Promise.resolve({ kind: "invalid-id", itemId }),
    async (safeId, { docs, email }) => {
      const collectionPath = sharedItemsPath(key);
      if (opts.refuseOverwrite) {
        const created = await guarded(key, email, () => docs.create(collectionPath, safeId, item));
        if (!created) return { kind: "conflict", itemId: safeId };
      } else {
        await guarded(key, email, () => docs.set(collectionPath, safeId, item));
      }
      if (opts.slug) publishShared(key, [safeId], "upsert");
      return { kind: "ok", itemId: safeId, item };
    },
  );
}

async function firestoreDelete(key: SharedCollectionKey, itemId: string, opts: IoOptions): Promise<DeleteItemResult> {
  return withSafeId<Promise<DeleteItemResult>>(
    itemId,
    () => Promise.resolve({ kind: "invalid-id", itemId }),
    async (safeId, { docs, email }) => {
      const removed = await guarded(key, email, () => docs.delete(sharedItemsPath(key), safeId));
      if (!removed) return { kind: "not-found", itemId: safeId };
      if (opts.slug) publishShared(key, [safeId], "delete");
      return { kind: "ok", itemId: safeId };
    },
  );
}

/** The store factory registered for `storage.type === "firestore"`.
 *  Synchronous and connection-agnostic by contract — see the header. */
export function firestoreStoreFor(collection: LoadedCollection, opts: IoOptions): CollectionStore {
  const { primaryKey } = collection.schema;
  const ioOpts: IoOptions = { ...opts, slug: opts.slug ?? collection.slug };
  // Every method is `async` and resolves the key INSIDE itself, so a bad
  // identity rejects the one call instead of throwing out of the factory. The
  // factory is called from ontology / validate / route handlers that list many
  // collections; one that throws there takes an unrelated screen down with it.
  return {
    capabilities: { writable: true, nativeQuery: false, nativePaging: false },
    list: async () => firestoreList(keyOf(collection), primaryKey),
    page: async (pageOpts = {}) => firestorePage(keyOf(collection), primaryKey, pageOpts),
    read: async (itemId: string) => firestoreRead(keyOf(collection), itemId, primaryKey),
    write: async (itemId: string, item: CollectionItem, writeOpts: WriteOptions = {}) =>
      firestoreWrite(keyOf(collection), itemId, item, { ...ioOpts, refuseOverwrite: writeOpts.refuseOverwrite }),
    delete: async (itemId: string) => firestoreDelete(keyOf(collection), itemId, ioOpts),
  };
}
