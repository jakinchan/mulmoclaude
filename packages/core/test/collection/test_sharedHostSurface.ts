// The surface a SHARED-COLLECTION HOST needs from this package.
//
// Shared collections are hosted by MulmoTerminal, which owns the operations
// (deploy / publish / unpublish), their write ORDER, and the tool the agent
// calls. This package owns the pure parts: what is valid, what the documents
// look like, where they live.
//
// This test exists because that split only pays off if the host never has to
// come back here. Every symbol below is one MulmoTerminal imports; a refactor
// that drops or renames one is a cross-repository release, not a local edit,
// so it should fail HERE first — while the person doing it is still looking at
// this package.
//
// WHAT IS LEFT HERE IS THE RUNTIME HALF. The shared-app COMPILER — the
// declaration, the projections, the publish gate — moved to
// `receptron/sharedapp`, which the host consumes by git ref. So this list got
// SHORTER on purpose, and the reason is at the bottom of this file.
//
// Adding to this list is fine. Removing from it means a host is about to break.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as server from "../../src/collection/server/index.ts";

const HOST_SURFACE = [
  // the host seam: who serves shared collections, and with whose session
  "configureCollectionHost",
  "setSharedCollectionsSupport",
  "hostSupportsSharedCollections",
  "setFirestoreAccessor",
  "firestoreHandle",
  // reading the repository's declaration
  "loadAppManifest",
  "APP_MANIFEST_FILE",
  // the gate over live RECORDS — which existing rows a schema change breaks.
  // (What refuses a DECLARATION is `sharedapp`'s `publishProblems`.)
  "validateCollectionRecords",
  "MAX_RECORD_ISSUES",
  "STORE_UNREADABLE",
  // finding the collections to deploy
  "discoverCollections",
  "loadCollection",
  // where a shared collection's items live
  "sharedItemsPath",
];

test("every symbol a shared-collection host imports is exported", () => {
  const missing = HOST_SURFACE.filter((name) => !(name in server));
  assert.deepEqual(missing, [], `not exported from @mulmoclaude/core/collection/server: ${missing.join(", ")}`);
});

test("the shared-app compiler is not here, and must not come back", () => {
  // `app.json` -> the documents a published app is made of, and the gate that
  // refuses a declaration, live in `receptron/sharedapp`. They left because
  // nothing in THIS monorepo consumed them — MulmoClaude neither writes nor
  // reads a shared collection — and every change to them was a release of this
  // package that somebody had to publish by hand. In the 90 days before the
  // split, 24 commits paid that toll.
  //
  // Re-adding one here would put the toll back for whatever it touches, and it
  // would be the SECOND implementation: the host would keep compiling with
  // `sharedapp` while this package's tests passed on its own copy.
  //
  // mulmoterminal plans/refactor-shared-app-module.md
  for (const name of ["projectApp", "projectAppViews", "projectDeploy", "projectPublish", "AuthoredAppZ", "publishProblems", "normalizeViews"]) {
    assert.equal(name in server, false, `${name} belongs to receptron/sharedapp`);
  }
});

test("the engine exposes no whole-app publish operation", () => {
  // `publishApp` used to live here and did deploy and publish in one write.
  // It cannot come back: a host that declares the capability would then have a
  // SECOND write path — one that skips staging and writes the `public` block
  // first, which is the ordering the design makes fail-closed. The operations
  // belong to the host; this package only says what is valid.
  assert.equal("publishApp" in server, false);
});
