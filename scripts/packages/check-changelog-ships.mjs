#!/usr/bin/env node
// Does the CHANGELOG's `Ships …` line match what the launcher actually pulls in?
//
// Every app release ends with a hand-typed roster of thirteen
// `@mulmoclaude/<pkg>@<version>` strings. Nothing derived it and nothing checked
// it, so it was a list of facts maintained by retyping them — and its MEANING
// drifted too: 1.8.0 / 1.11.0 / 1.12.0 list the launcher's dependency roster,
// while 1.9.0 / 1.10.0 listed the packages published during that release window
// instead. Two different questions answered by the same sentence.
//
// This pins the first meaning — the roster a reader can act on ("which package
// versions am I getting?") — and makes it checkable.
//
// Usage: node scripts/packages/check-changelog-ships.mjs
//
// WHICH section is checked: `[Unreleased]` when it carries a `Ships` line,
// otherwise the launcher's current version. Both mean the same thing — "the
// roster the next launcher release will pull in" — and the manifest read here
// is today's, so a FROZEN section must never be the target: comparing it would
// force a published release's historical record to be rewritten to versions it
// never shipped.
//
// That is not hypothetical. A `chore(release)` that publishes packages must NOT
// bump the launcher (docs/package-releases.md), so the launcher's version still
// names an ALREADY-PUBLISHED release while its dependency ranges have moved on.
// Checking `## [<that version>]` then demands editing history. `[Unreleased]` is
// where those ranges belong until /publish-mulmoclaude renames it to the new
// version — at which point this falls back to the version section as before.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHANGELOG = "docs/CHANGELOG.md";
const LAUNCHER_MANIFEST = "packages/mulmoclaude/package.json";
const SCOPE = "@mulmoclaude/";

/** The `@mulmoclaude/*` roster the launcher declares, as `name@version` strings. */
export const declaredRoster = (manifest) =>
  Object.entries(manifest.dependencies ?? {})
    .filter(([name]) => name.startsWith(SCOPE))
    .map(([name, range]) => `${name}@${range.replace(/^[\^~]/, "")}`)
    .sort();

/** The `## [X.Y.Z]` (or `## [Unreleased]`) section body, or null when the
 *  CHANGELOG has no such heading. */
export const releaseSection = (changelog, version) => {
  const heading = `## [${version}]`;
  const start = changelog.indexOf(heading);
  if (start < 0) return null;
  const rest = changelog.slice(start + heading.length);
  const end = rest.indexOf("\n## [");
  return end < 0 ? rest : rest.slice(0, end);
};

// Derived from SCOPE so the two cannot drift apart: `@scope/name@version`
// inside backticks. Requiring the `@version` is what skips prose mentions like
// `@mulmoclaude/*-plugin`.
const ROSTER_ENTRY = new RegExp(`\`(${SCOPE.replace("/", "\\/")}[^\`@]+@[^\`]+)\``, "g");

/** The roster the `Ships …` line claims. Null when the section has no such line.
 *  Returning null is a LOUD failure, not a silent skip — `main` reports it and
 *  exits 1 — so the line is matched strictly rather than guessed at. */
export const claimedRoster = (section) => {
  const line = section.split("\n").find((entry) => entry.trimStart().startsWith("Ships `"));
  if (!line) return null;
  return [...line.matchAll(ROSTER_ENTRY)].map((match) => match[1]).sort();
};

/** Which section states the roster to check, as `{ label, section }`.
 *  `[Unreleased]` when it carries a `Ships` line — a launcher release being
 *  prepared without a version number yet — otherwise the launcher's current
 *  version section. `section` is null when neither exists.
 *
 *  Split out of `main` so the CHOICE is directly testable: it is the part that
 *  decides whether a published release's record gets rewritten, and testing the
 *  two helpers it composes does not cover it. */
export const targetSection = (changelog, version) => {
  const unreleased = releaseSection(changelog, "Unreleased");
  if (unreleased !== null && claimedRoster(unreleased) !== null) return { label: "Unreleased", section: unreleased };
  return { label: version, section: releaseSection(changelog, version) };
};

const duplicatesIn = (entries) => [...new Set(entries.filter((entry, index) => entries.indexOf(entry) !== index))];

/** Both directions, so neither a forgotten addition nor a stale entry can hide.
 *  `duplicated` is the third way to disagree: set membership alone calls a line
 *  that names one package twice a match for a roster that names it once. */
export const compareRosters = (claimed, declared) => ({
  missing: declared.filter((entry) => !claimed.includes(entry)),
  stale: claimed.filter((entry) => !declared.includes(entry)),
  duplicated: duplicatesIn(claimed),
});

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function main() {
  const manifest = readJson(LAUNCHER_MANIFEST);
  const { version } = manifest;
  const declared = declaredRoster(manifest);

  const { label, section } = targetSection(readFileSync(CHANGELOG, "utf8"), version);
  if (section === null) {
    console.error(`[changelog:ships] ${CHANGELOG} has no "## [${label}]" section.`);
    console.error("  A launcher publish needs a changelog entry — see /publish-mulmoclaude §9a.");
    return 1;
  }

  const claimed = claimedRoster(section);
  if (claimed === null) {
    console.error(`[changelog:ships] the [${label}] section has no \`Ships …\` line.`);
    console.error(`  End the section with: Ships \`${declared.join("`, `")}\`.`);
    return 1;
  }

  const { missing, stale, duplicated } = compareRosters(claimed, declared);
  if (missing.length === 0 && stale.length === 0 && duplicated.length === 0) {
    console.log(`[changelog:ships] OK — [${label}] lists all ${claimed.length} @mulmoclaude/* dependencies.`);
    return 0;
  }

  console.error(`[changelog:ships] the [${label}] \`Ships\` line disagrees with ${LAUNCHER_MANIFEST}:`);
  for (const entry of missing) console.error(`  - missing: ${entry}`);
  for (const entry of stale) console.error(`  - not a current dependency: ${entry}`);
  for (const entry of duplicated) console.error(`  - listed more than once: ${entry}`);
  console.error("");
  console.error("  The line answers 'which package versions does this launcher pull in?' —");
  console.error("  not 'what did we publish this week'. Fix the line, not the manifest.");
  return 1;
}

// Only run the CLI when invoked directly, so tests can import the helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main();
}
