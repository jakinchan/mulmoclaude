// What a collection IS, as a value.
//
// Until now a collection's identity was `(root, slug)` — see the INVARIANT on
// `CollectionHost` — and that is still exactly right for a collection that
// lives in a directory. A SHARED collection does not: it is published to
// Firestore under `apps/{aid}/collections/{cid}`, several machines resolve it,
// and no one of their paths is its name. Keying it by the path it happened to
// be published from would make the same collection two collections.
//
// The two identities COEXIST. A local collection's behaviour must not change at
// all, so this is a discriminated union rather than a widening of either one:
// every surface the INVARIANT enumerates — a cache, a pubsub channel, a view
// token, a notification id, a rendered card — keys on this type, and the
// compiler then refuses the thing that keeps happening by hand, which is keying
// on the NAME alone (`slug` / `cid`) and letting two collections that share a
// name collide.
//
// Isomorphic on purpose: a card and a channel name are decided on both sides of
// the wire, so this module imports nothing from node.

import { SAFE_SLUG_PATTERN } from "./ids";

/** A collection in a directory. `root` must already be canonical
 *  (`canonicalRoot`) — it is an identity here, not a path to read, and `/proj`
 *  vs `/proj/` would be two collections. Server callers should build these
 *  through `localCollectionKey` in `collection/server`, which canonicalises;
 *  the arm is spelled out here so the type itself stays isomorphic. */
export interface LocalCollectionKey {
  kind: "local";
  root: string;
  slug: string;
}

/** A collection published to a shared app: `apps/{aid}/collections/{cid}`.
 *  `aid` is committed in the repository, so every clone resolves the same
 *  collection and an invitation is about authorization, never discovery. */
export interface SharedCollectionKey {
  kind: "shared";
  aid: string;
  cid: string;
}

export type CollectionKey = LocalCollectionKey | SharedCollectionKey;

export const isLocalCollectionKey = (key: CollectionKey): key is LocalCollectionKey => key.kind === "local";
export const isSharedCollectionKey = (key: CollectionKey): key is SharedCollectionKey => key.kind === "shared";

/** Build a local key from an ALREADY-CANONICAL root. */
export const localCollectionKeyOf = (root: string, slug: string): LocalCollectionKey => ({
  kind: "local",
  root: scopePart(root, "root"),
  slug: namePart(slug, "slug"),
});

/** Build a shared key. */
export const sharedCollectionKey = (aid: string, cid: string): SharedCollectionKey => ({
  kind: "shared",
  aid: namePart(aid, "aid"),
  cid: namePart(cid, "cid"),
});

/** The collection's NAME within its scope: the slug, or the shared `cid`.
 *
 *  This is what a schema file, a URL segment and a label are keyed by, and it
 *  is deliberately NOT enough to identify a collection — that is the whole
 *  point of the union. Use it to look things up INSIDE a known scope, never as
 *  a map key across scopes. */
export const collectionKeyName = (key: CollectionKey): string => (key.kind === "local" ? key.slug : key.cid);

// NUL separates the parts: it cannot occur in a path, a slug, an app id or a
// collection id, so the encoding is unambiguous and needs no escaping.
const SEP = "\u0000";

/** A ROOT: any non-empty string that can be encoded. A path's charset is the
 *  filesystem's, so the only thing to require is that it survives the encoding.
 *
 *  "NUL cannot occur in a path" is true of every real value and is the reason
 *  the encoding needs no escaping — but a type whose whole job is to be an
 *  identity must not take the claim on trust. Without this, `("a\0b", "c")`
 *  and `("a", "b\0c")` encode to the SAME string, so `sameCollectionKey` calls
 *  two different collections equal and the id parses back to nothing. Empty is
 *  refused for the same reason: it makes the id ambiguous about which part was
 *  missing.
 *
 *  A throw, where `parseCollectionKeyId` returns null: building a key is code
 *  making an identity, and a bad one there is a programming error. Parsing is
 *  reading something off a disk or a wire, where an unrecognised entry is a
 *  thing to skip. */
function scopePart(value: string, field: string): string {
  if (value.length === 0) throw new Error(`CollectionKey: ${field} must not be empty`);
  if (value.includes(SEP)) throw new Error(`CollectionKey: ${field} must not contain NUL`);
  return value;
}

/** A NAME — a slug, a shared `cid`, or an `aid`: the collection-slug charset,
 *  `[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?`.
 *
 *  THIS TYPE IS THE SINGLE SOURCE OF TRUTH for what a name may be, and that is
 *  the point rather than a nicety. A name is re-encoded by every downstream
 *  identity — the completion-bell id (`<scope>\0<name>:<itemId>`, split at the
 *  first colon), a pubsub channel (`collection:app/<aid>/<name>`), a cache key
 *  — and each of those has a different character it cannot survive. With the
 *  rule stated only downstream, the layers disagree: a cid of `sales:2026`
 *  builds fine, then the bell id decodes as a DIFFERENT collection and the
 *  channel name throws inside a publisher whose catch swallows it, so the live
 *  update simply stops arriving. One rule here makes every encoding safe by
 *  construction; the checks downstream stay as belt-and-braces for callers that
 *  never went through a key.
 *
 *  A local slug is already `safeSlugName`-validated upstream, so this changes
 *  nothing for it. A shared `aid` / `cid` had no gate at all — they are
 *  Firestore document ids under `apps/{aid}/collections/{cid}` AND the name the
 *  same collection has on disk, so the slug charset is what they already are. */
function namePart(value: string, field: string): string {
  if (!SAFE_SLUG_PATTERN.test(value)) throw new Error(`CollectionKey: ${field} "${value}" is not a valid collection name`);
  return value;
}

/** A stable string form, for the places that need a primitive key: a Map, a
 *  pubsub channel name, a notification id, a card's reconciliation key.
 *
 *  Round-trips through {@link parseCollectionKeyId}. The `kind` is written
 *  first so a local key and a shared key can never collide however their parts
 *  are spelled. */
export const collectionKeyId = (key: CollectionKey): string =>
  key.kind === "local" ? `local${SEP}${key.root}${SEP}${key.slug}` : `shared${SEP}${key.aid}${SEP}${key.cid}`;

/** Decode a {@link collectionKeyId}, or `null` when the string did not come
 *  from one. Null rather than a throw: these strings are read back from disk
 *  and off the wire, where an unrecognised entry is a thing to skip, not a
 *  crash. */
export function parseCollectionKeyId(encoded: string): CollectionKey | null {
  const parts = encoded.split(SEP);
  if (parts.length !== 3) return null;
  const [kind, first, second] = parts;
  if (kind === undefined || first === undefined || second === undefined) return null;
  if (first.length === 0 || second.length === 0) return null;
  if (kind === "local") return { kind: "local", root: first, slug: second };
  if (kind === "shared") return { kind: "shared", aid: first, cid: second };
  return null;
}

/** Do two keys name the same collection? */
export const sameCollectionKey = (one: CollectionKey, other: CollectionKey): boolean => collectionKeyId(one) === collectionKeyId(other);
