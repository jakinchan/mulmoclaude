// The repository's app declaration — `<root>/app.json` — and the one field
// this step reads from it: `aid`.
//
// WHY THE REPOSITORY AND NOT A BINDING. A shared collection's identity is
// `(aid, cid)`, and `aid` is COMMITTED, so every clone of the repository
// resolves the same app and an invitation is about authorization rather than
// discovery. That makes `aid` a property of the collection's LOCATION, exactly
// like `storage.path` — not a property of the session. A host binding would
// make it a process global, which is wrong the moment one server process serves
// several project roots (MulmoTerminal does), because then every repository's
// collections would point at one app.
//
// WHY NOT THE SCHEMA. The unit of sharing is the app, not the collection: four
// collections share one member roster and one public config, so `aid` sits once
// per repository rather than once per schema. A per-collection `aid` would also
// be a second place to change it, and the two would drift.
//
// AUTHORED, NOT PUBLISHED. This is the file a human (or the agent) writes. The
// Firestore document at `apps/{aid}` is a DIFFERENT thing that `publish`
// derives from it — flattened for the security rules to read, with epoch-millis
// windows and a derived `memberEmails`. Do not read this file as if it were
// that one, and do not write this file from anything that publishes.
//
// SCOPE. Only `aid` is read here. `members` / `public` belong to `publish`,
// which does not exist yet. `aidEnv` (a per-worktree app id, so a feature
// branch cannot mutate the team's live records) also does not: it needs the
// host to resolve a worktree variable that lives in MulmoTerminal's session
// environment and NOT in this process's `process.env`, so it arrives as a host
// resolver hook rather than a direct env read. Both land later; the point of
// funnelling every read through this one function is that they land HERE and
// nowhere else.

import { readFileSync } from "node:fs";
import path from "node:path";
import { isErrorWithCode, isRecord } from "@mulmoclaude/common";
import { isValidCollectionName } from "../core/collectionKey";

/** The app declaration's filename, at the repository root. */
export const APP_MANIFEST_FILE = "app.json";

/** What this step reads out of `app.json`. Deliberately one field: every key
 *  added here is a key `publish` and this loader could disagree about. */
export interface AppManifest {
  /** The app id — the `{aid}` in `apps/{aid}/collections/{cid}/items`. */
  aid: string;
}

/** Why a root has no usable `aid`. Returned rather than thrown because the
 *  caller is an acceptance gate whose whole job is to turn this into a
 *  one-line reason a collection was skipped. */
export type AppManifestFailure = { kind: "missing" } | { kind: "unreadable"; detail: string } | { kind: "malformed"; detail: string };

export type AppManifestResult = { ok: true; manifest: AppManifest } | ({ ok: false } & AppManifestFailure);

/** Read `<root>/app.json` and return its `aid`.
 *
 *  SYNCHRONOUS on purpose. The caller is `acceptParsedSchema`, which is sync
 *  and is shared by discovery and `manageCollection`'s `putSchema` precisely so
 *  that a schema which would be skipped on the next discovery cannot be written
 *  as if it were fine. Making this async would split that gate in two, and the
 *  half that lost the check is the half the author sees. The file is a few
 *  hundred bytes and is read once per firestore collection per discovery pass.
 *
 *  Never cached. `app.json` is edited by hand and by the agent, and a cache
 *  here would mean the app a collection points at is whatever it was when the
 *  server started. */
export function loadAppManifest(root: string): AppManifestResult {
  let raw: string;
  try {
    raw = readFileSync(path.join(root, APP_MANIFEST_FILE), "utf-8");
  } catch (err) {
    if (isErrorWithCode(err) && err.code === "ENOENT") return { ok: false, kind: "missing" };
    return { ok: false, kind: "unreadable", detail: String(err) };
  }
  return parseAppManifest(raw);
}

/** The parse half, exported so it can be tested without a filesystem.
 *
 *  `aid` is validated with `isValidCollectionName` — the SAME predicate the
 *  `CollectionKey` constructors apply — rather than a rule of its own. An `aid`
 *  is re-encoded downstream as a Firestore document id, a pubsub channel
 *  segment and a cache key, each with a different character that would break
 *  it; one rule, stated once, is what keeps those layers from disagreeing.
 *  Rejecting here rather than at `sharedCollectionKey` only changes WHERE the
 *  author is told: a reason on the collection they wrote, instead of a throw
 *  from inside a store call. */
export function parseAppManifest(raw: string): AppManifestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, kind: "malformed", detail: `not valid JSON (${String(err)})` };
  }
  if (!isRecord(parsed)) return { ok: false, kind: "malformed", detail: "is not a JSON object" };
  const { aid } = parsed;
  if (typeof aid !== "string" || aid.length === 0) return { ok: false, kind: "malformed", detail: "declares no `aid` string" };
  if (!isValidCollectionName(aid)) return { ok: false, kind: "malformed", detail: `\`aid\` '${aid}' is not a valid app id` };
  return { ok: true, manifest: { aid } };
}

/** The failure as the one line an author can act on. Kept next to the failure
 *  type so a new variant cannot be added without wording it. */
export function appManifestReason(failure: AppManifestFailure, root: string): string {
  const manifestPath = path.join(root, APP_MANIFEST_FILE);
  if (failure.kind === "missing") return `a shared collection needs an app: create ${manifestPath} declaring an \`aid\``;
  if (failure.kind === "unreadable") return `cannot read ${manifestPath}: ${failure.detail}`;
  return `${manifestPath} ${failure.detail}`;
}
