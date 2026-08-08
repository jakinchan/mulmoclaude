// The CHANGELOG's `Ships …` roster is hand-typed; this is what checks it.
//
// Sourcery raised it on #2829: thirteen `@mulmoclaude/<pkg>@<version>` strings
// maintained by retyping them, with nothing comparing them to the launcher's
// actual dependencies. Auditing the released entries found the values correct
// but the SENTENCE ambiguous — 1.8.0 / 1.11.0 / 1.12.0 list the dependency
// roster, 1.9.0 / 1.10.0 listed the packages published that week. These tests
// pin the first meaning.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claimedRoster, compareRosters, declaredRoster, releaseSection, targetSection } from "../../../scripts/packages/check-changelog-ships.mjs";

const manifest = {
  version: "1.12.0",
  dependencies: {
    "@mulmoclaude/core": "^2.1.0",
    "@mulmoclaude/common": "^1.2.0",
    "@mulmobridge/client": "^1.0.2",
    express: "^5.0.0",
  },
};

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [1.12.0] - 2026-08-07",
  "",
  "**Tagline.**",
  "",
  "Ships `@mulmoclaude/core@2.1.0`, `@mulmoclaude/common@1.2.0`.",
  "",
  "## [1.11.0] - 2026-08-05",
  "",
  "Ships `@mulmoclaude/core@2.0.2`.",
  "",
].join("\n");

describe("declaredRoster", () => {
  it("takes only @mulmoclaude/* deps, strips the range prefix, and sorts", () => {
    assert.deepEqual(declaredRoster(manifest), ["@mulmoclaude/common@1.2.0", "@mulmoclaude/core@2.1.0"]);
  });

  it("ignores @mulmobridge/* and third-party deps", () => {
    const roster = declaredRoster(manifest);
    assert.ok(!roster.some((entry) => entry.startsWith("@mulmobridge/")), "bridges are listed in their own section");
    assert.ok(!roster.some((entry) => entry.startsWith("express")));
  });

  it("strips ~ as well as ^", () => {
    assert.deepEqual(declaredRoster({ dependencies: { "@mulmoclaude/core": "~2.1.0" } }), ["@mulmoclaude/core@2.1.0"]);
  });

  it("survives a manifest with no dependencies at all", () => {
    assert.deepEqual(declaredRoster({}), []);
  });
});

describe("releaseSection", () => {
  it("returns the requested section and stops at the next heading", () => {
    const section = releaseSection(changelog, "1.12.0");
    assert.ok(section);
    assert.ok(section.includes("@mulmoclaude/common@1.2.0"));
    assert.ok(!section.includes("2.0.2"), "must not bleed into the previous release");
  });

  it("returns null for a version the changelog does not document", () => {
    assert.equal(releaseSection(changelog, "9.9.9"), null);
  });

  it("handles the last section, which has no following heading", () => {
    const section = releaseSection(changelog, "1.11.0");
    assert.ok(section?.includes("@mulmoclaude/core@2.0.2"));
  });
});

describe("claimedRoster", () => {
  it("reads the entries out of the Ships line", () => {
    const section = releaseSection(changelog, "1.12.0");
    assert.ok(section);
    assert.deepEqual(claimedRoster(section), ["@mulmoclaude/common@1.2.0", "@mulmoclaude/core@2.1.0"]);
  });

  it("returns null when the section has no Ships line", () => {
    assert.equal(claimedRoster("## [1.0.0]\n\nNo roster here.\n"), null);
  });

  it("tolerates an indented Ships line", () => {
    assert.deepEqual(claimedRoster("  Ships `@mulmoclaude/core@2.1.0`."), ["@mulmoclaude/core@2.1.0"]);
  });

  it("ignores backticked package names that carry no version", () => {
    assert.deepEqual(claimedRoster("Ships `@mulmoclaude/core@2.1.0`, plus the `@mulmoclaude/*-plugin` wave."), ["@mulmoclaude/core@2.1.0"]);
  });
});

describe("compareRosters", () => {
  it("reports nothing when the two agree", () => {
    const roster = ["@mulmoclaude/core@2.1.0"];
    assert.deepEqual(compareRosters(roster, roster), { missing: [], stale: [], duplicated: [] });
  });

  // Set membership alone called this a match: every claimed entry is declared
  // and every declared entry is claimed, so both lists came back empty for a
  // line that names one package twice. (CodeRabbit, #2831.)
  it("catches an entry the line names twice", () => {
    const result = compareRosters(["@mulmoclaude/core@2.1.0", "@mulmoclaude/core@2.1.0"], ["@mulmoclaude/core@2.1.0"]);
    assert.deepEqual(result.duplicated, ["@mulmoclaude/core@2.1.0"]);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.stale, []);
  });

  it("reports a duplicate once, however many times it repeats", () => {
    const thrice = ["@mulmoclaude/core@2.1.0", "@mulmoclaude/core@2.1.0", "@mulmoclaude/core@2.1.0"];
    assert.deepEqual(compareRosters(thrice, ["@mulmoclaude/core@2.1.0"]).duplicated, ["@mulmoclaude/core@2.1.0"]);
  });

  it("catches a dependency the line forgot", () => {
    const result = compareRosters(["@mulmoclaude/core@2.1.0"], ["@mulmoclaude/common@1.2.0", "@mulmoclaude/core@2.1.0"]);
    assert.deepEqual(result.missing, ["@mulmoclaude/common@1.2.0"]);
    assert.deepEqual(result.stale, []);
  });

  // The failure that actually happens: the roster is copied from the previous
  // release and one version is never updated.
  it("catches a version left at the previous release", () => {
    const result = compareRosters(["@mulmoclaude/core@2.0.2"], ["@mulmoclaude/core@2.1.0"]);
    assert.deepEqual(result.missing, ["@mulmoclaude/core@2.1.0"]);
    assert.deepEqual(result.stale, ["@mulmoclaude/core@2.0.2"]);
  });
});

// A `chore(release)` that publishes packages must not bump the launcher, so its
// version keeps naming an ALREADY-PUBLISHED release while its ranges move on.
// Checking `## [<that version>]` then demands rewriting a published release's
// record to versions it never shipped — which is what Codex caught on #2841.
// `[Unreleased]` is where the pending roster belongs until the launcher is
// actually versioned.
describe("targetSection", () => {
  it("falls through to the version section when Unreleased states no roster", () => {
    // The /publish-mulmoclaude shape: `[Unreleased]` exists as an empty
    // placeholder, so the version section is the one being prepared.
    const { label, section } = targetSection(changelog, "1.12.0");
    assert.equal(label, "1.12.0");
    assert.deepEqual(claimedRoster(section ?? ""), ["@mulmoclaude/common@1.2.0", "@mulmoclaude/core@2.1.0"]);
  });

  it("prefers Unreleased once it states a roster, so a published record is never the target", () => {
    // The chore(release) shape: ranges moved, launcher NOT bumped, so `1.12.0`
    // is already on npm. Targeting it would demand rewriting what it shipped.
    const withPending = changelog.replace("## [Unreleased]\n", "## [Unreleased]\n\nShips `@mulmoclaude/core@3.0.0`.\n");
    const { label, section } = targetSection(withPending, "1.12.0");
    assert.equal(label, "Unreleased");
    assert.deepEqual(claimedRoster(section ?? ""), ["@mulmoclaude/core@3.0.0"]);
  });

  it("reports a null section when neither heading exists", () => {
    assert.deepEqual(targetSection("# Changelog\n", "9.9.9"), { label: "9.9.9", section: null });
  });
});

describe("the real CHANGELOG and launcher manifest", () => {
  it("agree for the pending roster — [Unreleased] when present, else the launcher's version", async () => {
    const { main } = await import("../../../scripts/packages/check-changelog-ships.mjs");
    assert.equal(main(), 0, "run `node scripts/packages/check-changelog-ships.mjs` to see which entries disagree");
  });
});
