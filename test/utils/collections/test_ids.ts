// Unit tests for the pure id helpers (packages/core/src/collection/core/ids.ts).
// Focus: `generateUniqueId`'s collision re-roll and `nextUniqueItemId` (the
// existing-set build + re-roll lifted out of the view's `generateUniqueItemId`);
// the slug/record-id validators are exercised via schema tests already. Plus
// `newItemId`, whose output has to satisfy two contracts at once: the record-id
// sanitiser (it is the `<id>.json` filename stem) and Google's caller-chosen
// event id (a googleCalendar collection pushes the record id straight to it).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateUniqueId, isSafeRecordId, newItemId, nextUniqueItemId, type CollectionItem } from "@mulmoclaude/core/collection";
import { generateItemId } from "@mulmoclaude/core/collection/server";
import { isClientSettableEventId } from "@mulmoclaude/core/google";

// A v4 UUID with its hyphens stripped: 32 hex chars, the version nibble at
// index 12 and the variant at index 16 still in place.
const GENERATED_ID_PATTERN = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/;

/** A deterministic generator returning the given ids in order, then repeating
 *  the last one forever — models `newItemId` for a fixed roll sequence. */
function sequence(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const picked = ids[Math.min(index, ids.length - 1)];
    if (picked === undefined) throw new Error("sequence() needs at least one id");
    index++;
    return picked;
  };
}

describe("newItemId", () => {
  it("returns a hyphen-free v4 UUID", () => {
    assert.match(newItemId(), GENERATED_ID_PATTERN);
  });

  it("passes the record-id sanitiser, so it is a legal <id>.json stem", () => {
    // A generated id that failed here would 400 every blank-id create.
    for (let i = 0; i < 100; i++) assert.ok(isSafeRecordId(newItemId()));
  });

  // The reason the hyphens are stripped. A googleCalendar collection sends the
  // record id as the caller-chosen event id, and Google takes base32hex only —
  // a hyphenated id is refused, so every UI-created record would push as
  // "the record id cannot be used as a Google event id".
  it("is usable as a Google event id", () => {
    for (let i = 0; i < 100; i++) assert.ok(isClientSettableEventId(newItemId()));
  });

  it("is what the server mints for a blank-id create (`generateItemId` delegates)", () => {
    assert.match(generateItemId(), GENERATED_ID_PATTERN);
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newItemId()));
    assert.equal(ids.size, 1000);
  });
});

describe("generateUniqueId", () => {
  it("returns the first candidate when nothing collides", () => {
    assert.equal(generateUniqueId(new Set(), sequence("a", "b")), "a");
  });

  it("returns the first candidate when it is free even if the set is non-empty", () => {
    assert.equal(generateUniqueId(new Set(["x", "y"]), sequence("a")), "a");
  });

  it("re-rolls past colliding candidates to the first free one", () => {
    const gen = sequence("dup1", "dup2", "free");
    assert.equal(generateUniqueId(new Set(["dup1", "dup2"]), gen), "free");
  });

  it("stops re-rolling as soon as a free id appears (no extra calls)", () => {
    let calls = 0;
    const gen = (): string => {
      calls++;
      return calls === 1 ? "dup" : "free";
    };
    assert.equal(generateUniqueId(new Set(["dup"]), gen), "free");
    assert.equal(calls, 2);
  });

  it("gives up after maxAttempts re-rolls and returns the last candidate (caller's overwrite guard is the backstop)", () => {
    let calls = 0;
    const gen = (): string => {
      calls++;
      return "always";
    };
    // Every candidate collides; with the default 8 re-rolls that is 1 initial
    // roll + 8 retries = 9 generate calls, and the (still-colliding) value is
    // returned rather than looping forever.
    assert.equal(generateUniqueId(new Set(["always"]), gen), "always");
    assert.equal(calls, 9);
  });

  it("honours a custom maxAttempts", () => {
    let calls = 0;
    const gen = (): string => {
      calls++;
      return "always";
    };
    generateUniqueId(new Set(["always"]), gen, 2);
    assert.equal(calls, 3); // 1 initial + 2 retries
  });
});

describe("nextUniqueItemId", () => {
  const items: CollectionItem[] = [{ id: "a" }, { id: "b" }, { n: 7 }];

  it("returns the first candidate that collides with no loaded record's primary key", () => {
    assert.equal(nextUniqueItemId(items, "id", sequence("a", "b", "free")), "free");
  });

  it("accepts the first candidate when nothing collides", () => {
    assert.equal(nextUniqueItemId(items, "id", sequence("fresh")), "fresh");
  });

  it("builds the existing set from the given primary key, ignoring other keys", () => {
    // "7" lives under `n`, not `id`, so it does not block an id-keyed roll of "7".
    assert.equal(nextUniqueItemId(items, "id", sequence("7")), "7");
  });

  it("treats a record missing the primary key as the empty id", () => {
    // The `{ n: 7 }` record contributes "" to the id set, so "" collides.
    assert.equal(nextUniqueItemId(items, "id", sequence("", "ok")), "ok");
  });

  it("returns from an empty collection on the first roll", () => {
    assert.equal(nextUniqueItemId([], "id", sequence("only")), "only");
  });
});
