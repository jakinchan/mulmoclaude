// `normalizeAttachments` is the single point where the two persisted
// attachment shapes meet (#2308): bare path strings from sessions recorded
// before the change, `{ path, filename }` objects since. Every chip in the
// chat history renders off its output, so a session written by an older
// build has to keep rendering rather than throw or vanish.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAttachments } from "../../../src/utils/attachment/entries.js";

const LEGACY_PATH = "data/attachments/2026/04/abc.png";
const STORED_PATH = "data/attachments/2026/07/b458a5d0.csv";

describe("normalizeAttachments — the two persisted shapes", () => {
  it("widens a pre-#2308 path string into an entry with no filename", () => {
    assert.deepEqual(normalizeAttachments([LEGACY_PATH]), [{ path: LEGACY_PATH }]);
  });

  it("passes an object entry through with its filename", () => {
    assert.deepEqual(normalizeAttachments([{ path: STORED_PATH, filename: "商品カタログ_v2.csv" }]), [{ path: STORED_PATH, filename: "商品カタログ_v2.csv" }]);
  });

  it("reads a session that mixes both shapes", () => {
    // A conversation spanning the upgrade: early turns hold strings, later
    // turns hold objects, and both render in the same history.
    assert.deepEqual(normalizeAttachments([LEGACY_PATH, { path: STORED_PATH, filename: "sales.csv" }]), [
      { path: LEGACY_PATH },
      { path: STORED_PATH, filename: "sales.csv" },
    ]);
  });

  it("preserves declaration order so chips match the order files were attached", () => {
    const raw = [{ path: "a.png" }, "b.png", { path: "c.png" }];
    assert.deepEqual(
      normalizeAttachments(raw).map((entry) => entry.path),
      ["a.png", "b.png", "c.png"],
    );
  });
});

describe("normalizeAttachments — degrading instead of throwing", () => {
  it("returns [] for undefined / null / a non-array", () => {
    assert.deepEqual(normalizeAttachments(undefined), []);
    assert.deepEqual(normalizeAttachments(null), []);
    assert.deepEqual(normalizeAttachments("data/attachments/x.png"), []);
    assert.deepEqual(normalizeAttachments(42), []);
  });

  it("returns [] for an empty array", () => {
    assert.deepEqual(normalizeAttachments([]), []);
  });

  it("drops entries with no usable path, keeping the rest of the turn's chips", () => {
    const raw = [LEGACY_PATH, "", { filename: "orphan.csv" }, { path: "" }, null, undefined, 7];
    assert.deepEqual(normalizeAttachments(raw), [{ path: LEGACY_PATH }]);
  });

  it("omits a blank or non-string filename rather than rendering an empty label", () => {
    assert.deepEqual(normalizeAttachments([{ path: STORED_PATH, filename: "" }]), [{ path: STORED_PATH }]);
    assert.deepEqual(normalizeAttachments([{ path: STORED_PATH, filename: 42 }]), [{ path: STORED_PATH }]);
  });

  it("ignores unknown extra keys on an entry", () => {
    // Forward compatibility: a newer host may add fields this build has
    // no view for, and that must not cost the user their chip.
    assert.deepEqual(normalizeAttachments([{ path: STORED_PATH, filename: "a.csv", mimeType: "text/csv" }]), [{ path: STORED_PATH, filename: "a.csv" }]);
  });
});
