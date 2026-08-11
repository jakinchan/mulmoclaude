// A shared (firestore-backed) collection needs a host that says it serves one.
//
// The rule being expressed is D5 of the shareable-collection design: shared
// collections live in a PROJECT REPOSITORY, one `app.json` per repo, not in a
// single managed workspace where one roster would govern every unrelated
// collection sitting side by side. That is a property the host knows about
// itself, so the host declares it and the engine asks — rather than the engine
// testing for a particular host's workspace, which would put a host's name in
// shared code and make every MulmoTerminal-only change a change to this package.
//
// The gate is on ACCEPTANCE, not on discovery's listing: a refused schema is
// reported with a reason, while a skipped one just vanishes and reads as
// "this collection is empty".
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { configureCollectionHost, acceptParsedSchema, CollectionSchemaZ } from "../../src/collection/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
const root = makeTempDir("shared-cap-");

// ONE binding per file: the host slot refuses a re-bind with a different host
// by design, so the capability's other state lives in its own file
// (`test_sharedCapabilityOn.ts`). Not declaring it at all is the case under
// test here — that is what MulmoClaude does, and `false` reaches the same
// predicate (`=== true`).
function bindHost(): void {
  configureCollectionHost({
    workspaceRoot: root,
    log: noopLog,
    paths: {
      userSkillsDir: (wsRoot: string) => path.join(wsRoot, ".user-skills"),
      projectSkillsDir: (wsRoot: string) => path.join(wsRoot, ".claude", "skills"),
      feedsRoot: (wsRoot: string) => path.join(wsRoot, "data", "feeds"),
      skillsStagingDir: (wsRoot: string) => path.join(wsRoot, "data", "skills"),
      archiveDir: "data/archive",
      collectionsRegistriesConfig: (wsRoot: string) => path.join(wsRoot, "config", "collections-registries.json"),
    },
    isPresetSlug: () => false,
  });
}

const idField = { type: "text", label: "ID", primary: true };

const sharedSchema = CollectionSchemaZ.parse({
  title: "Bookings",
  icon: "event",
  storage: { type: "firestore" },
  primaryKey: "id",
  fields: { id: idField },
});

const localSchema = CollectionSchemaZ.parse({
  title: "Notes",
  icon: "note",
  dataPath: "data/collections/notes/items",
  primaryKey: "id",
  fields: { id: idField },
});

const accept = (schema: typeof sharedSchema) => acceptParsedSchema(schema, { source: "project", workspaceRoot: root, slug: "bookings" });

bindHost();

test("a host that does not declare the capability refuses a shared collection, with a reason", () => {
  const refused = accept(sharedSchema);
  assert.equal(refused.ok, false);
  // The reason has to name the shape of the fix. "not supported" alone sends the
  // author looking for a missing dependency.
  assert.match(refused.ok ? "" : refused.reason, /shared collections/);
  assert.match(refused.ok ? "" : refused.reason, /project repository/);
});

test("a local collection is unaffected by the capability", () => {
  // The gate must not become a switch that turns the whole engine off for a
  // host without Firestore: MulmoClaude keeps every non-shared collection.
  assert.equal(accept(localSchema).ok, true);
});
