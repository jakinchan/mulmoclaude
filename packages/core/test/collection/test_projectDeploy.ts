// The deploy / publish split of the authored -> published projection.
//
// `projectApp` (whole-app, one shot) stays because it is what mulmoserver's
// emulator rules test generates its fixtures from. These three are what a host
// needs to run the two operations SEPARATELY — a host is otherwise forced to
// re-derive which keys belong to which write, which is the kind of duplication
// that drifts.
//
// What the tests here are really pinning is the SAFETY of the split, not the
// key lists: deploy must not carry `public` (the rules authorize anonymous
// access from it, so deploying to test would publish), and promotion must
// re-stamp (the stamp answers "which version is public now").
import { test } from "node:test";
import assert from "node:assert/strict";

import { projectApp, projectDeploy, projectPublish, promoteSchema, appSchemasPath, appStagingPath } from "../../src/collection/server/publishProject";
import { parseAuthoredApp } from "../../src/collection/server/publishManifest";
import { CollectionSchemaZ } from "../../src/collection/core/schemaZ";

const authored = parseAuthoredApp(
  JSON.stringify({
    aid: "3f2b8c1a-0000-4000-8000-000000000000",
    name: "Sakura Hair",
    members: { "owner@example.com": { "*": "owner" } },
    public: { enabled: true, read: ["bookings"], submit: { bookings: { auth: "verifiedEmail", createFields: ["customerName"] } } },
  }),
);
assert.equal(authored.ok, true);
const app = authored.ok
  ? authored.app
  : (() => {
      throw new Error("unreachable");
    })();

const schema = CollectionSchemaZ.parse({
  title: "Bookings",
  icon: "event",
  storage: { type: "firestore" },
  primaryKey: "id",
  fields: { id: { type: "text", label: "ID", primary: true } },
});

const deployStamp = { publishedAt: 1000, email: "owner@example.com", uid: "uid_owner", commit: "abc123", dirty: false };
const publishStamp = { publishedAt: 2000, email: "other@example.com", uid: "uid_owner", commit: "def456", dirty: false };

test("deploy carries no `public` — the block the rules authorize anonymous access from", () => {
  const { app: doc } = projectDeploy(app, [{ cid: "bookings", schema }], deployStamp, null);
  assert.equal("public" in doc, false);
  // …while everything the roster needs is there: deploying IS how an invitation
  // takes effect, so `members` must not be staged.
  assert.deepEqual(doc.members, app.members);
  assert.deepEqual(doc.memberEmails, ["owner@example.com"]);
});

test("publish carries the `public` block and the world-readable config, and nothing else", () => {
  const face = projectPublish(app, publishStamp);
  assert.deepEqual(face.public, { enabled: true, read: ["bookings"], submit: { bookings: { auth: "verifiedEmail", createFields: ["customerName"] } } });
  assert.equal(face.config.enabled, true);
  // The roster is NOT in the public config — a participant reading it would see
  // everyone else's address.
  assert.equal("members" in face.config, false);
  assert.equal("memberEmails" in face.config, false);
});

test("an author with no `public` block publishes nothing public", () => {
  const priv = parseAuthoredApp(JSON.stringify({ aid: app.aid, name: "Sakura Hair", members: app.members }));
  assert.equal(priv.ok, true);
  const face = projectPublish(priv.ok ? priv.app : app, publishStamp);
  assert.equal(face.public, undefined); // the rules read a missing block as "not public"
  assert.equal(face.config.enabled, false);
});

test("promotion re-stamps — the stamp says which version is PUBLIC, not when it was staged", () => {
  const { staging } = projectDeploy(app, [{ cid: "bookings", schema }], deployStamp, null);
  const promoted = promoteSchema(staging[0].doc, publishStamp);
  assert.deepEqual(promoted.publishedSchema, staging[0].doc.publishedSchema); // what was tested is what ships
  assert.equal(promoted.publishedAt, 2000);
  assert.equal(promoted.publishedBy, "other@example.com");
  assert.equal(promoted.publishedCommit, "def456");
});

test("the split writes the same app keys the one-shot projection does, minus `public`", () => {
  // Guards the drift this API exists to prevent: a key added to projectApp and
  // forgotten in the split would leave a deployed app missing it.
  const whole = projectApp(app, [{ cid: "bookings", schema }], deployStamp, null);
  const { app: deployed } = projectDeploy(app, [{ cid: "bookings", schema }], deployStamp, null);
  assert.deepEqual(
    Object.keys(deployed).sort(),
    Object.keys(whole.app)
      .filter((key) => key !== "public")
      .sort(),
  );
});

test("staged and published schemas live at separate paths", () => {
  // A field beside `publishedSchema` could not work: rules cannot hide a field,
  // so a draft inside a document the public page reads is a published draft.
  assert.notEqual(appStagingPath(app.aid), appSchemasPath(app.aid));
});
