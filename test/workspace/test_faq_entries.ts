import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFaqEntries, entryHasPointer, parsePointerLine } from "@mulmoclaude/core/workspace-setup";

// Unit tests for the bug-report FAQ parser. The shipped file is checked
// separately (test_bug_report_faq.ts); this file pins the format rules that
// make that check meaningful.

describe("parsePointerLine", () => {
  it("reads each known field into its list", () => {
    assert.deepEqual(parsePointerLine("configKey: voiceInput"), { list: "configKeys", value: "voiceInput" });
    assert.deepEqual(parsePointerLine("source: server/x.ts"), { list: "sources", value: "server/x.ts" });
    assert.deepEqual(parsePointerLine("help: sandbox.md"), { list: "helps", value: "sandbox.md" });
  });

  it("tolerates whitespace around the field name and value", () => {
    assert.deepEqual(parsePointerLine("configKey :   voiceInput  "), { list: "configKeys", value: "voiceInput" });
  });

  it("keeps a value containing further colons intact", () => {
    // A URL or a Windows path would otherwise be truncated at its own colon.
    assert.deepEqual(parsePointerLine("help: a.md: see also"), { list: "helps", value: "a.md: see also" });
  });

  it("rejects prose, unknown fields, empty values and leading colons", () => {
    assert.equal(parsePointerLine("Note: this is prose"), null);
    assert.equal(parsePointerLine("configKey:"), null);
    assert.equal(parsePointerLine(": orphan"), null);
    assert.equal(parsePointerLine("no colon here"), null);
    assert.equal(parsePointerLine(""), null);
  });

  it("does not resolve a field name through the prototype chain", () => {
    assert.equal(parsePointerLine("constructor: boom"), null);
    assert.equal(parsePointerLine("toString: boom"), null);
  });
});

describe("parseFaqEntries", () => {
  it("reads a heading and its three pointer kinds", () => {
    const entries = parseFaqEntries(
      ["## Voice input does nothing", "", "configKey: voiceInput", "source: packages/core/src/whisper", "help: error-recovery.md", "", "Prose."].join("\n"),
    );
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      symptom: "Voice input does nothing",
      configKeys: ["voiceInput"],
      sources: ["packages/core/src/whisper"],
      helps: ["error-recovery.md"],
    });
  });

  it("repeats a field into a list", () => {
    const [entry] = parseFaqEntries(["## Two helps", "help: a.md", "help: b.md"].join("\n"));
    assert.ok(entry);
    assert.deepEqual(entry.helps, ["a.md", "b.md"]);
  });

  it("splits multiple entries at each heading", () => {
    const entries = parseFaqEntries(["## First", "configKey: one", "## Second", "configKey: two"].join("\n"));
    assert.deepEqual(
      entries.map((entry) => entry.symptom),
      ["First", "Second"],
    );
    const [, second] = entries;
    assert.ok(second);
    assert.deepEqual(second.configKeys, ["two"]);
  });

  it("ignores the format example inside a fenced block", () => {
    // The real file documents the entry shape in a fence. Parsing that block
    // would invent an entry whose pointers are placeholders, and CI would then
    // demand a config key literally named `<a key in settings.json>`.
    const entries = parseFaqEntries(["# Title", "```", "## Example symptom", "configKey: <a key>", "```", "## Real symptom", "configKey: real"].join("\n"));
    assert.deepEqual(
      entries.map((entry) => entry.symptom),
      ["Real symptom"],
    );
    const [entry] = entries;
    assert.ok(entry);
    assert.deepEqual(entry.configKeys, ["real"]);
  });

  it("drops pointer lines that appear before the first heading", () => {
    const entries = parseFaqEntries(["configKey: orphan", "## Later", "configKey: kept"].join("\n"));
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry);
    assert.deepEqual(entry.configKeys, ["kept"]);
  });

  it("ignores prose that merely contains a colon", () => {
    const [entry] = parseFaqEntries(["## Symptom", "Note: this sentence is prose, not a pointer.", "configKey: real"].join("\n"));
    assert.ok(entry);
    assert.deepEqual(entry.configKeys, ["real"]);
    assert.deepEqual(entry.sources, []);
    assert.deepEqual(entry.helps, []);
  });

  it("ignores a field with an empty value", () => {
    const [entry] = parseFaqEntries(["## Symptom", "configKey:", "configKey:   "].join("\n"));
    assert.ok(entry);
    assert.deepEqual(entry.configKeys, []);
  });

  it("does not resolve a field name through the prototype chain", () => {
    // `constructor: x` would hit Object.prototype if the field table were a
    // plain object literal, and push into an undefined list.
    const [entry] = parseFaqEntries(["## Symptom", "constructor: boom", "toString: boom", "configKey: real"].join("\n"));
    assert.ok(entry);
    assert.deepEqual(entry.configKeys, ["real"]);
  });

  it("returns no entries for empty or heading-free input", () => {
    assert.deepEqual(parseFaqEntries(""), []);
    assert.deepEqual(parseFaqEntries("# Title only\n\nSome prose.\n"), []);
  });

  it("keeps an entry that has no pointers, so the caller can reject it", () => {
    // The parser must not silently drop these — reporting them is the whole
    // point of `entryHasPointer`.
    const entries = parseFaqEntries("## Unverifiable\n\nJust prose.\n");
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry);
    assert.equal(entryHasPointer(entry), false);
  });

  it("accepts an entry with any single pointer kind", () => {
    const [byConfig] = parseFaqEntries("## A\nconfigKey: k");
    const [bySource] = parseFaqEntries("## B\nsource: s");
    const [byHelp] = parseFaqEntries("## C\nhelp: h.md");
    assert.ok(byConfig);
    assert.ok(bySource);
    assert.ok(byHelp);
    assert.equal(entryHasPointer(byConfig), true);
    assert.equal(entryHasPointer(bySource), true);
    assert.equal(entryHasPointer(byHelp), true);
  });
});
