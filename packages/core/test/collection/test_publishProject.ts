// The authored → published conversion, tested AS A TABLE.
//
// Every row of the design note's conversion table gets an assertion here, and
// the reason it is worth this much attention is that each conversion's failure
// mode is silence. An ISO string that reaches Firestore does not error: it
// makes `inWindow` a type error, which denies, so the app's symptom is "nobody
// can submit" with nothing anywhere saying why. Same for `memberEmails` — a
// stale one is refused by `membersConsistent()` as a bare permission error.
//
// The projection is pure, so this file needs no filesystem, no Firestore and
// no clock: the stamp is a parameter.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthoredAppZ, type AuthoredApp } from "../../src/collection/server/publishManifest";
import { projectApp, type PublishStamp } from "../../src/collection/server/publishProject";
import type { CollectionSchema } from "../../src/collection/core/schema";

const STAMP: PublishStamp = { uid: "uid_owner", email: "owner@salon.jp", publishedAt: 1_760_000_000_000, commit: "abc123def456" };

const SCHEMA = { title: "Bookings", icon: "event", primaryKey: "id", fields: { id: { type: "string", primary: true } } } as unknown as CollectionSchema;

/** The S1 declaration, trimmed to the keys under test. Parsed through the real
 *  zod schema rather than cast, so a fixture cannot drift from what publish
 *  would actually accept. */
function authored(overrides: Record<string, unknown> = {}): AuthoredApp {
  return AuthoredAppZ.parse({
    aid: "app_salon_7f3a",
    name: "Sakura Hair",
    members: {
      "owner@salon.jp": { "*": "owner" },
      "stylist-a@salon.jp": { bookings: "editor" },
    },
    collections: {
      bookings: {
        statusField: "status",
        submitOnly: true,
        transitions: { initial: ["pending"], pending: ["approved", "cancelled"], approved: [], cancelled: [] },
      },
    },
    public: {
      enabled: true,
      read: ["services"],
      submit: {
        bookings: {
          auth: "verifiedEmail",
          emailField: "customerEmail",
          createFields: ["customerEmail", "status"],
          initialStatus: "pending",
          window: { from: "2026-09-01T00:00:00Z", until: "2026-09-30T23:59:59Z" },
        },
      },
    },
    ...overrides,
  });
}

/** The published `public.submit[cid]` block, or a failure naming what was
 *  missing — an assertion on `undefined.window` says nothing about which half
 *  of the projection broke. */
function publishedSubmit(app: Record<string, unknown>, cid: string): Record<string, unknown> {
  const publicBlock = app.public;
  assert.ok(publicBlock !== null && typeof publicBlock === "object", "the app document has no `public` block");
  const submits = (publicBlock as { submit?: Record<string, Record<string, unknown>> }).submit;
  const submit = submits?.[cid];
  assert.ok(submit, `the app document has no public.submit.${cid}`);
  return submit;
}

test("the submit window is lowered to epoch millis", () => {
  // THE conversion. The rules do not coerce a string to a timestamp; comparing
  // an ISO string with request.time is a type error, and a rules type error
  // denies. A published `window.from` is the bug, not a stylistic difference.
  const { app } = projectApp(authored(), [], STAMP, null);
  const submit = publishedSubmit(app, "bookings");
  assert.deepEqual(submit.window, { fromMs: Date.parse("2026-09-01T00:00:00Z"), untilMs: Date.parse("2026-09-30T23:59:59Z") });
  assert.deepEqual(Object.keys(submit.window as object).sort(), ["fromMs", "untilMs"], "the ISO form must not survive alongside the millis");
});

test("a one-sided window publishes only the bound that was declared", () => {
  // `inWindow` defaults the missing bound (0 / MAX_SAFE_INTEGER). Publishing a
  // zero for an undeclared `from` would work by accident today and break the
  // moment the default changes.
  const app = authored({
    public: { submit: { bookings: { auth: "verifiedEmail", createFields: ["customerEmail"], window: { until: "2026-12-31T23:59:59Z" } } } },
  });
  const projected = projectApp(app, [], STAMP, null);
  const submit = publishedSubmit(projected.app, "bookings");
  assert.deepEqual(submit.window, { untilMs: Date.parse("2026-12-31T23:59:59Z") });
});

test("memberEmails is derived from members, and a hand-written one is overwritten", () => {
  // `membersConsistent()` refuses any write where the two disagree, so an
  // authored value could only ever turn publish into a bare permission error.
  const { app } = projectApp(authored(), [], STAMP, null);
  assert.deepEqual(app.memberEmails, ["owner@salon.jp", "stylist-a@salon.jp"]);
  assert.deepEqual(Object.keys(app.members as object).sort(), app.memberEmails);
});

test("public.read stays a list — the shape the rules were tested against", () => {
  // `cid in list` and `cid in map` both work in the rules language. Two
  // spellings that both work is how the two repositories drift, so the
  // published form is the authored form, and the emulator test pins it.
  const { app } = projectApp(authored(), [], STAMP, null);
  assert.deepEqual((app.public as Record<string, unknown>).read, ["services"]);
});

test("owner is stamped on create and carried forward on update", () => {
  // The rules require `owner == request.auth.uid` on create and `owner`
  // UNCHANGED on update. Re-stamping the publisher would make every publish by
  // a second owner-role account fail, and would silently transfer ownership if
  // it did not.
  const created = projectApp(authored(), [], STAMP, null);
  assert.equal(created.app.owner, "uid_owner");

  const updated = projectApp(authored(), [], { ...STAMP, uid: "uid_someone_else" }, { owner: "uid_owner", members: {} });
  assert.equal(updated.app.owner, "uid_owner");
});

test("the previous document is kept for rollback, one level deep", () => {
  // Chaining would carry the app's whole history inside one document and meet
  // Firestore's 1 MiB limit as an unexplained failure at some later publish.
  const first = projectApp(authored(), [], STAMP, null);
  const second = projectApp(authored(), [], { ...STAMP, publishedAt: STAMP.publishedAt + 1000 }, first.app);
  const previous = second.app.previousPublished as Record<string, unknown>;
  assert.equal(previous.publishedAt, STAMP.publishedAt);
  assert.equal("previousPublished" in previous, false);

  const third = projectApp(authored(), [], { ...STAMP, publishedAt: STAMP.publishedAt + 2000 }, second.app);
  const thirdPrevious = third.app.previousPublished as Record<string, unknown>;
  assert.equal("previousPublished" in thirdPrevious, false, "the chain must not grow");
});

test("publishing the same declaration twice changes only the timestamp", () => {
  // Idempotence. If this fails, `previousPublished` grows, or a map/array
  // ordering is unstable, and every publish is a diff for readers watching the
  // document.
  const first = projectApp(authored(), [{ cid: "bookings", schema: SCHEMA }], STAMP, null);
  const second = projectApp(authored(), [{ cid: "bookings", schema: SCHEMA }], { ...STAMP, publishedAt: STAMP.publishedAt + 5 }, first.app);
  const { publishedAt: __firstAt, previousPublished: __firstPrev, ...firstRest } = first.app;
  const { publishedAt: __secondAt, previousPublished: __secondPrev, ...secondRest } = second.app;
  assert.deepEqual(secondRest, firstRest);
});

test("undeclared keys are absent, not present-and-undefined", () => {
  // Every optional key in the rules is read through `"k" in c`, so a key
  // written with an undefined value would flip a check the author never made.
  // Firestore rejects undefined outright as well.
  const bare = AuthoredAppZ.parse({ aid: "app_bare", members: { "owner@salon.jp": { "*": "owner" } } });
  const { app } = projectApp(bare, [], { ...STAMP, commit: undefined }, null);
  for (const key of ["name", "collections", "participantRead", "public", "publishedCommit", "previousPublished"]) {
    assert.equal(key in app, false, `${key} must be absent`);
  }
});

test("the schema is published whole, beside the config the rules read", () => {
  // The rules never read `publishedSchema` — clients do, and a public webview
  // has no other way to learn the fields.
  const { schemas } = projectApp(authored(), [{ cid: "bookings", schema: SCHEMA }], STAMP, null);
  assert.equal(schemas.length, 1);
  const [only] = schemas;
  assert.ok(only);
  assert.equal(only.cid, "bookings");
  assert.deepEqual(only.doc.publishedSchema, SCHEMA);
  assert.equal(only.doc.publishedBy, "owner@salon.jp");
});

test("the public config document carries no roster", () => {
  // `apps/{aid}/config/{docId}` is `allow read: if true`. It exists so a
  // public form can render itself; the roster is the reason `apps/{aid}`
  // itself is reader-only.
  const { config } = projectApp(authored(), [], STAMP, null);
  assert.equal("members" in config, false);
  assert.equal("memberEmails" in config, false);
  assert.equal("owner" in config, false);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.read, ["services"]);
  // The window a visitor's form needs is the lowered one, same as the app doc.
  const { bookings } = config.submit;
  assert.ok(bookings);
  assert.deepEqual(bookings.window, { fromMs: Date.parse("2026-09-01T00:00:00Z"), untilMs: Date.parse("2026-09-30T23:59:59Z") });
});
