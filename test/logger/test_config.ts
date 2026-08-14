import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, resolveConfig } from "../../server/system/logger/config.js";

describe("resolveConfig", () => {
  it("returns defaults when env is empty", () => {
    const config = resolveConfig({});
    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  it("applies LOG_LEVEL to both console and file levels", () => {
    const config = resolveConfig({ LOG_LEVEL: "debug" });
    assert.equal(config.sinks.console.level, "debug");
    assert.equal(config.sinks.file.level, "debug");
  });

  it("per-sink levels override the coarse LOG_LEVEL", () => {
    const config = resolveConfig({
      LOG_LEVEL: "debug",
      LOG_CONSOLE_LEVEL: "warn",
    });
    assert.equal(config.sinks.console.level, "warn");
    assert.equal(config.sinks.file.level, "debug");
  });

  it("ignores invalid level and falls back to default", () => {
    const config = resolveConfig({ LOG_LEVEL: "chatty" });
    assert.equal(config.sinks.console.level, DEFAULT_CONFIG.sinks.console.level);
  });

  // A membership test written with `in` walks the prototype chain, so these
  // used to pass as levels. `LEVEL_PRIORITY["constructor"]` is then a function,
  // every `priority <= function` comparison is false, and the process runs with
  // every log record discarded — with no error and no way to notice (#2321).
  it("rejects a level named after an Object.prototype member", () => {
    for (const level of ["constructor", "tostring", "valueof", "hasownproperty"]) {
      const config = resolveConfig({ LOG_LEVEL: level });
      assert.equal(config.sinks.console.level, DEFAULT_CONFIG.sinks.console.level, `${level} must not be accepted`);
      assert.equal(config.sinks.file.level, DEFAULT_CONFIG.sinks.file.level, `${level} must not be accepted`);
    }
  });

  it("rejects a prototype-named level on the per-sink overrides too", () => {
    const config = resolveConfig({ LOG_CONSOLE_LEVEL: "constructor", LOG_FILE_LEVEL: "constructor", LOG_TELEMETRY_LEVEL: "constructor" });
    assert.equal(config.sinks.console.level, DEFAULT_CONFIG.sinks.console.level);
    assert.equal(config.sinks.file.level, DEFAULT_CONFIG.sinks.file.level);
    assert.equal(config.sinks.telemetry.level, DEFAULT_CONFIG.sinks.telemetry.level);
  });

  it("accepts format overrides per sink", () => {
    const config = resolveConfig({
      LOG_CONSOLE_FORMAT: "json",
      LOG_FILE_FORMAT: "text",
    });
    assert.equal(config.sinks.console.format, "json");
    assert.equal(config.sinks.file.format, "text");
  });

  it("ignores invalid format and keeps default", () => {
    const config = resolveConfig({ LOG_CONSOLE_FORMAT: "xml" });
    assert.equal(config.sinks.console.format, DEFAULT_CONFIG.sinks.console.format);
  });

  it("accepts LOG_CONSOLE_STREAM=stderr and defaults to the level split", () => {
    assert.equal(resolveConfig({ LOG_CONSOLE_STREAM: "stderr" }).sinks.console.stream, "stderr");
    assert.equal(resolveConfig({ LOG_CONSOLE_STREAM: "STDERR" }).sinks.console.stream, "stderr");
    assert.equal(resolveConfig({}).sinks.console.stream, "split");
  });

  it("ignores an invalid LOG_CONSOLE_STREAM and keeps default", () => {
    assert.equal(resolveConfig({ LOG_CONSOLE_STREAM: "syslog" }).sinks.console.stream, DEFAULT_CONFIG.sinks.console.stream);
  });

  it("parses enabled flags (true/false/1/0/yes/no)", () => {
    assert.equal(resolveConfig({ LOG_FILE_ENABLED: "false" }).sinks.file.enabled, false);
    assert.equal(resolveConfig({ LOG_FILE_ENABLED: "0" }).sinks.file.enabled, false);
    assert.equal(resolveConfig({ LOG_CONSOLE_ENABLED: "no" }).sinks.console.enabled, false);
    assert.equal(resolveConfig({ LOG_CONSOLE_ENABLED: "yes" }).sinks.console.enabled, true);
  });

  it("ignores invalid enabled flag and keeps default", () => {
    const config = resolveConfig({ LOG_CONSOLE_ENABLED: "maybe" });
    assert.equal(config.sinks.console.enabled, true);
  });

  it("accepts LOG_FILE_DIR override", () => {
    const config = resolveConfig({ LOG_FILE_DIR: "/tmp/logs" });
    assert.equal(config.sinks.file.dir, "/tmp/logs");
  });

  it("accepts a positive integer for LOG_FILE_MAX_FILES", () => {
    const config = resolveConfig({ LOG_FILE_MAX_FILES: "7" });
    assert.equal(config.sinks.file.rotation.maxFiles, 7);
  });

  it("ignores non-positive or non-integer maxFiles", () => {
    assert.equal(resolveConfig({ LOG_FILE_MAX_FILES: "0" }).sinks.file.rotation.maxFiles, DEFAULT_CONFIG.sinks.file.rotation.maxFiles);
    assert.equal(resolveConfig({ LOG_FILE_MAX_FILES: "-3" }).sinks.file.rotation.maxFiles, DEFAULT_CONFIG.sinks.file.rotation.maxFiles);
    assert.equal(resolveConfig({ LOG_FILE_MAX_FILES: "abc" }).sinks.file.rotation.maxFiles, DEFAULT_CONFIG.sinks.file.rotation.maxFiles);
  });

  it("supports telemetry enabled + level override", () => {
    const config = resolveConfig({
      LOG_TELEMETRY_ENABLED: "true",
      LOG_TELEMETRY_LEVEL: "warn",
    });
    assert.equal(config.sinks.telemetry.enabled, true);
    assert.equal(config.sinks.telemetry.level, "warn");
  });

  it("reads LOG_SOURCE and leaves it unset by default (#2904)", () => {
    assert.equal(resolveConfig({ LOG_SOURCE: "mcp-broker" }).source, "mcp-broker");
    assert.equal(resolveConfig({}).source, undefined);
  });

  it("treats an empty or whitespace-only LOG_SOURCE as unset", () => {
    // `LOG_SOURCE=$UNSET_VAR` is a shell accident, not a process named " ".
    assert.equal(resolveConfig({ LOG_SOURCE: "" }).source, undefined);
    assert.equal(resolveConfig({ LOG_SOURCE: "   " }).source, undefined);
  });

  it("trims surrounding whitespace off a real LOG_SOURCE", () => {
    assert.equal(resolveConfig({ LOG_SOURCE: "  mcp-broker\n" }).source, "mcp-broker");
  });

  // The text formatter interpolates the label verbatim, so a newline inside it
  // would close the line early and let the rest pose as its own log entry.
  // (Codex review on #2905.)
  it("strips control characters so a label cannot forge a second log line", () => {
    const forged = "mcp-broker\n2026-01-01T00:00:00.000Z ERROR [auth] forged";
    const source = resolveConfig({ LOG_SOURCE: forged }).source ?? "";
    assert.ok(!source.includes("\n"), `newline survived: ${JSON.stringify(source)}`);
    assert.ok(!source.includes("\r"));
    assert.ok(source.startsWith("mcp-broker"));
  });

  it("strips CR, tab, ESC and DEL as well as LF", () => {
    const ESC = String.fromCharCode(0x1b);
    const DEL = String.fromCharCode(0x7f);
    const C1_CSI = String.fromCharCode(0x9b);
    assert.equal(resolveConfig({ LOG_SOURCE: `a\rb` }).source, "ab");
    assert.equal(resolveConfig({ LOG_SOURCE: `a\tb` }).source, "ab");
    // The brackets go too — they are not label characters, and a `[` inside the
    // label would make the text line's bracket structure ambiguous.
    assert.equal(resolveConfig({ LOG_SOURCE: `a${ESC}[31mb` }).source, "a31mb");
    assert.equal(resolveConfig({ LOG_SOURCE: `a${DEL}b` }).source, "ab");
    assert.equal(resolveConfig({ LOG_SOURCE: `a${C1_CSI}b` }).source, "ab");
  });

  // The denylist form of this filter passed the ASCII cases above and still let
  // these through: U+2028/U+2029 break a line in Unicode-aware viewers, and
  // U+202E reverses the rendering of everything after it. (Codex iter-2 on
  // #2905 — the reason the filter became an allowlist.)
  it("strips Unicode line/paragraph separators and bidi overrides", () => {
    const LINE_SEP = "\u2028";
    const PARA_SEP = "\u2029";
    const RLO = "\u202e";
    const ZWJ = "\u200d";
    assert.equal(resolveConfig({ LOG_SOURCE: `a${LINE_SEP}b` }).source, "ab");
    assert.equal(resolveConfig({ LOG_SOURCE: `a${PARA_SEP}b` }).source, "ab");
    assert.equal(resolveConfig({ LOG_SOURCE: `a${RLO}b` }).source, "ab");
    assert.equal(resolveConfig({ LOG_SOURCE: `a${ZWJ}b` }).source, "ab");
    assert.equal(resolveConfig({ LOG_SOURCE: `mcp-broker${LINE_SEP}ERROR [auth] forged` }).source, "mcp-brokerERRORauthforged");
  });

  it("keeps only the allowlisted label characters", () => {
    assert.equal(resolveConfig({ LOG_SOURCE: "mcp-broker_2.worker:a/b" }).source, "mcp-broker_2.worker:a/b");
    // Non-ASCII is dropped: the field is a machine-readable process tag, and an
    // allowlist that admits arbitrary scripts is back to guessing which of them
    // render as a line break.
    assert.equal(resolveConfig({ LOG_SOURCE: "ワーカー" }).source, undefined);
  });

  it("treats an all-control-character LOG_SOURCE as unset", () => {
    assert.equal(resolveConfig({ LOG_SOURCE: "\n\r\t" }).source, undefined);
  });

  it("caps the label so a bad value cannot pad every line", () => {
    const source = resolveConfig({ LOG_SOURCE: "x".repeat(200) }).source ?? "";
    assert.equal(source.length, 32);
  });
});
