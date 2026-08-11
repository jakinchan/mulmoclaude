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
// This file is the capability's ON state; `test_sharedCapability.ts` is the OFF
// one. They are separate FILES because the host slot refuses a re-bind with a
// different host — one binding per process.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { configureCollectionHost, acceptParsedSchema, CollectionSchemaZ } from "../../src/collection/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

const noopLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
const root = makeTempDir("shared-cap-on-");

// ONE binding per file: the host slot refuses a re-bind with a different host
// by design, so the capability's other state lives in its own file
// (`test_sharedCapabilityOn.ts`). Not declaring it at all is the case under
// test here — that is what MulmoClaude does, and `false` reaches the same
// predicate (`=== true`).
function bindHost(): void {
  configureCollectionHost({
    workspaceRoot: root,
    log: noopLog,
    sharedCollections: true,
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

bindHost();

test("a host that declares the capability gets past the gate — and is then asked for app.json", () => {
  const refused = acceptParsedSchema(sharedSchema, { source: "project", workspaceRoot: root, slug: "bookings" });
  // No `app.json` in the temp root, so it still fails — but for the NEXT
  // reason, which is what proves the capability gate let it through.
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /app\.json/);
});
