// Pins the SKILL.md `description:` scalar parsing used by the export path. The
// host parses frontmatter with js-yaml; this self-contained reader must match
// for the common scalar forms (CODEX / CodeRabbit review on #1866): quoted
// values, escaped quotes, and inline comments must not leak into meta.json.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSkillDescription } from "../../src/collection/registry/server/skillDescription.ts";

const withFrontmatter = (descriptionLine: string): string => `---\nname: movies\n${descriptionLine}\n---\n# Body`;

describe("parseSkillDescription — scalar forms", () => {
  it("reads a plain unquoted scalar", () => {
    assert.equal(parseSkillDescription(withFrontmatter("description: Movies I track.")), "Movies I track.");
  });

  it("strips surrounding double quotes", () => {
    assert.equal(parseSkillDescription(withFrontmatter('description: "Movies I track."')), "Movies I track.");
  });

  it("strips surrounding single quotes and unescapes doubled quotes", () => {
    assert.equal(parseSkillDescription(withFrontmatter("description: 'it''s mine'")), "it's mine");
  });

  it("unescapes escaped quotes inside a double-quoted scalar", () => {
    assert.equal(parseSkillDescription(withFrontmatter('description: "She said \\"hi\\""')), 'She said "hi"');
  });

  it("keeps a literal # inside a double-quoted scalar and drops a trailing inline comment", () => {
    assert.equal(parseSkillDescription(withFrontmatter('description: "A #1 helper" # inline note')), "A #1 helper");
  });

  it("drops an inline comment after a plain scalar", () => {
    assert.equal(parseSkillDescription(withFrontmatter("description: foo # bar")), "foo");
  });

  it("keeps a # that is not preceded by whitespace (e.g. C#)", () => {
    assert.equal(parseSkillDescription(withFrontmatter("description: Track C# code")), "Track C# code");
  });
});

describe("parseSkillDescription — absent / degenerate", () => {
  it("returns '' when there is no frontmatter envelope", () => {
    assert.equal(parseSkillDescription("# Just a body\nno frontmatter"), "");
  });

  it("returns '' when the description key is missing", () => {
    assert.equal(parseSkillDescription("---\nname: movies\n---\n# Body"), "");
  });

  it("returns '' for an empty description value", () => {
    assert.equal(parseSkillDescription(withFrontmatter("description:")), "");
  });

  it("returns '' for a block-scalar indicator (not expanded)", () => {
    assert.equal(parseSkillDescription(withFrontmatter("description: |")), "");
  });

  it("does not read a description that appears after the closing fence", () => {
    assert.equal(parseSkillDescription("---\nname: movies\n---\ndescription: in the body"), "");
  });

  it("returns '' for a malformed quoted scalar (missing closing quote)", () => {
    // js-yaml treats an unterminated quote as invalid YAML; we degrade to ""
    // rather than silently truncating to the collected prefix.
    assert.equal(parseSkillDescription(withFrontmatter('description: "foo')), "");
    assert.equal(parseSkillDescription(withFrontmatter("description: 'foo")), "");
  });

  it("returns '' for non-comment trailing text after a closing quote", () => {
    assert.equal(parseSkillDescription(withFrontmatter('description: "foo" bar')), "");
  });
});

// The two quoted forms are scanned by one shared loop that differs only in how
// it reads an escape pair. These pin the per-form escape rules so a change to
// the shared scanner can't quietly move one form onto the other's semantics.
describe("parseSkillDescription — quoted-scalar escape rules", () => {
  it("expands \\n and \\t inside a double-quoted scalar", () => {
    assert.equal(parseSkillDescription(withFrontmatter('description: "a\\nb\\tc"')), "a\nb\tc");
  });

  it("collapses an unknown double-quote escape to the literal character", () => {
    assert.equal(parseSkillDescription(withFrontmatter('description: "a\\\\b"')), "a\\b");
    assert.equal(parseSkillDescription(withFrontmatter('description: "a\\qb"')), "aqb");
  });

  it("returns '' for a scalar ending in a dangling backslash (nothing left to escape)", () => {
    assert.equal(parseSkillDescription(withFrontmatter('description: "foo\\')), "");
  });

  it("does not treat a backslash as an escape in a single-quoted scalar", () => {
    assert.equal(parseSkillDescription(withFrontmatter("description: 'a\\nb'")), "a\\nb");
  });

  it("reads a single-quoted scalar that is only a doubled quote", () => {
    assert.equal(parseSkillDescription(withFrontmatter("description: ''''")), "'");
  });

  it("does not treat a doubled quote as an escape in a double-quoted scalar", () => {
    // `""` closes an empty scalar; the trailing `"" ` would be non-comment text.
    assert.equal(parseSkillDescription(withFrontmatter('description: ""')), "");
  });
});
