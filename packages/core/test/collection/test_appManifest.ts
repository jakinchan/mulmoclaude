// `app.json` — the repository's app declaration, and the one field a shared
// collection needs from it.
//
// The parse half is tested without a filesystem; the read half only has to be
// checked for the distinction that matters downstream, which is "no file" vs
// "a file that says nothing usable" — discovery turns each into a different
// line for the author.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { appManifestReason, loadAppManifest, parseAppManifest } from "../../src/collection/server/appManifest";

test("parseAppManifest reads the aid and nothing else", () => {
  // `members` / `public` belong to publish; reading them here would be a second
  // place that could disagree with it.
  const parsed = parseAppManifest(JSON.stringify({ aid: "app_salon_7f3a", members: { "a@b.jp": { "*": "owner" } } }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.manifest : null, { aid: "app_salon_7f3a" });
});

test("parseAppManifest refuses an aid no downstream encoding could carry", () => {
  // The rule is `isValidCollectionName`, the SAME predicate the CollectionKey
  // constructors apply — not a rule of its own. An aid is re-encoded as a
  // Firestore document id, a pubsub channel segment and a bell id, and a layer
  // with its own rule is how those come to disagree silently.
  for (const aid of ["app/../other", "sales:2026", "app id", "", "-leading", "trailing-"]) {
    const parsed = parseAppManifest(JSON.stringify({ aid }));
    assert.equal(parsed.ok, false, `must refuse ${JSON.stringify(aid)}`);
  }
});

test("parseAppManifest distinguishes malformed shapes, and says which", () => {
  assert.equal(parseAppManifest("{").ok, false);
  assert.equal(parseAppManifest("[]").ok, false);
  assert.equal(parseAppManifest("{}").ok, false);
  const noAid = parseAppManifest(JSON.stringify({ name: "Salon" }));
  assert.equal(noAid.ok, false);
  assert.equal(!noAid.ok && noAid.kind, "malformed");
  assert.match(!noAid.ok && noAid.kind === "malformed" ? noAid.detail : "", /aid/);
});

test("loadAppManifest tells a missing file apart from an unusable one", () => {
  const root = mkdtempSync(path.join(tmpdir(), "app-manifest-"));
  try {
    const missing = loadAppManifest(root);
    assert.equal(missing.ok, false);
    assert.equal(missing.ok ? "" : missing.kind, "missing");
    // The reason has to name the file to create — this line is all the author
    // sees when their collection is skipped.
    assert.match(appManifestReason({ kind: "missing" }, root), /app\.json/);

    writeFileSync(path.join(root, "app.json"), JSON.stringify({ aid: "app_7f3a" }));
    const found = loadAppManifest(root);
    assert.deepEqual(found.ok ? found.manifest : null, { aid: "app_7f3a" });

    // A directory named app.json is neither missing nor malformed: reporting it
    // as "missing" would send the author to create a file that is already there.
    rmSync(path.join(root, "app.json"));
    mkdirSync(path.join(root, "app.json"));
    const unreadable = loadAppManifest(root);
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.ok ? "" : unreadable.kind, "unreadable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
