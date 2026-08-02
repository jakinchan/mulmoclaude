import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractText,
  truncateMiddle,
  parseClaudeJsonResult,
  validateSummaryResult,
  formatSpawnError,
  MAX_INPUT_CHARS,
  HEAD_CHARS,
  TAIL_CHARS,
  PER_MESSAGE_MAX,
  buildSummarizeCliArgs,
} from "../../server/workspace/chat-index/summarizer.js";

describe("extractText", () => {
  it("keeps user and assistant text turns", () => {
    const jsonl = [
      JSON.stringify({ source: "user", type: "text", message: "hello" }),
      JSON.stringify({ source: "assistant", type: "text", message: "hi" }),
    ].join("\n");
    const out = extractText(jsonl);
    assert.match(out, /\[user\] hello/);
    assert.match(out, /\[assistant\] hi/);
  });

  it("skips tool_result lines", () => {
    const jsonl = [
      JSON.stringify({ source: "user", type: "text", message: "ask" }),
      JSON.stringify({
        source: "tool",
        type: "tool_result",
        message: "noisy tool output",
      }),
    ].join("\n");
    const out = extractText(jsonl);
    assert.match(out, /ask/);
    assert.doesNotMatch(out, /noisy tool output/);
  });

  it("tolerates malformed lines without throwing", () => {
    const jsonl = ["not json at all", JSON.stringify({ source: "user", type: "text", message: "good" }), "{ bad json"].join("\n");
    const out = extractText(jsonl);
    assert.match(out, /good/);
  });

  it("returns empty string for no text entries", () => {
    const jsonl = JSON.stringify({
      source: "tool",
      type: "tool_result",
      message: "x",
    });
    assert.equal(extractText(jsonl), "");
  });

  it("truncates an over-long message with an ellipsis", () => {
    const long = "a".repeat(PER_MESSAGE_MAX + 1000);
    const jsonl = JSON.stringify({
      source: "user",
      type: "text",
      message: long,
    });
    const out = extractText(jsonl);
    // Clipped to PER_MESSAGE_MAX chars + "…", so shorter than input.
    assert.ok(out.length < long.length);
    assert.ok(out.endsWith("…"));
  });

  it("joins turns with a blank line separator", () => {
    const jsonl = [
      JSON.stringify({ source: "user", type: "text", message: "one" }),
      JSON.stringify({ source: "assistant", type: "text", message: "two" }),
    ].join("\n");
    const out = extractText(jsonl);
    assert.match(out, /one\n\n\[assistant\] two/);
  });
});

describe("truncateMiddle", () => {
  it("passes short input through unchanged", () => {
    const str = "hello world";
    assert.equal(truncateMiddle(str), str);
  });

  it("keeps head + tail and drops the middle for over-long input", () => {
    // Distinct head/tail markers + a middle filler larger than the
    // whole window, so the assertion can prove the middle is dropped.
    const head = "HEAD_MARKER".padEnd(HEAD_CHARS, "h");
    const middle = "m".repeat(MAX_INPUT_CHARS);
    const tail = "TAIL_MARKER".padStart(TAIL_CHARS, "t");
    const out = truncateMiddle(head + middle + tail);
    assert.ok(out.length < (head + middle + tail).length);
    assert.match(out, /HEAD_MARKER/);
    assert.match(out, /TAIL_MARKER/);
    // Middle "m" filler should be dropped.
    assert.doesNotMatch(out, /mmmmmmmmmmmmmmmm/);
  });
});

describe("parseClaudeJsonResult", () => {
  it("returns the SummaryResult on a success envelope", () => {
    const stdout = JSON.stringify({
      structured_output: {
        title: "Billy Bootcamp schedule",
        summary: "Two-week exercise plan.",
        keywords: ["workout", "schedule", "plan"],
      },
    });
    const out = parseClaudeJsonResult(stdout);
    assert.equal(out.title, "Billy Bootcamp schedule");
    assert.equal(out.summary, "Two-week exercise plan.");
    assert.deepEqual(out.keywords, ["workout", "schedule", "plan"]);
  });

  it("throws on an error envelope", () => {
    const stdout = JSON.stringify({
      is_error: true,
      result: "rate limited",
    });
    assert.throws(() => parseClaudeJsonResult(stdout), /rate limited/);
  });

  it("throws on malformed json", () => {
    assert.throws(() => parseClaudeJsonResult("{ not json"), /failed to parse claude json output/);
  });
});

describe("validateSummaryResult", () => {
  it("returns a SummaryResult for a well-formed object", () => {
    const out = validateSummaryResult({
      title: "t",
      summary: "s",
      keywords: ["a", "b"],
    });
    assert.equal(out.title, "t");
    assert.equal(out.summary, "s");
    assert.deepEqual(out.keywords, ["a", "b"]);
  });

  it("coerces missing fields to safe defaults", () => {
    const out = validateSummaryResult({});
    assert.equal(out.title, "");
    assert.equal(out.summary, "");
    assert.deepEqual(out.keywords, []);
  });

  it("drops non-string keywords", () => {
    const out = validateSummaryResult({
      title: "t",
      summary: "s",
      keywords: ["ok", 42, null, "also-ok"],
    });
    assert.deepEqual(out.keywords, ["ok", "also-ok"]);
  });

  it("throws when the input is not an object", () => {
    assert.throws(() => validateSummaryResult(null), /not an object/);
    assert.throws(() => validateSummaryResult("string"), /not an object/);
  });

  it("treats non-array keywords as empty", () => {
    const out = validateSummaryResult({
      title: "t",
      summary: "s",
      keywords: "not an array",
    });
    assert.deepEqual(out.keywords, []);
  });
});

describe("formatSpawnError", () => {
  it("extracts errors[] from the claude JSON envelope on stdout", () => {
    const stdout = JSON.stringify({
      is_error: true,
      subtype: "error_max_budget_usd",
      errors: ["Reached maximum budget ($0.05)"],
    });
    const msg = formatSpawnError(1, stdout, "");
    assert.match(msg, /exited 1/);
    assert.match(msg, /Reached maximum budget/);
  });

  it("joins multiple structured errors with '; '", () => {
    const stdout = JSON.stringify({
      is_error: true,
      errors: ["first problem", "second problem"],
    });
    const msg = formatSpawnError(1, stdout, "");
    assert.match(msg, /first problem; second problem/);
  });

  it("falls back to subtype + result when errors[] is missing", () => {
    const stdout = JSON.stringify({
      is_error: true,
      subtype: "rate_limited",
      result: "try again later",
    });
    const msg = formatSpawnError(1, stdout, "");
    assert.match(msg, /rate_limited: try again later/);
  });

  it("falls back to stderr when stdout has no structured error", () => {
    const msg = formatSpawnError(1, "not json", "bad thing happened");
    assert.match(msg, /bad thing happened/);
  });

  it("ignores successful envelopes on stdout (is_error !== true)", () => {
    const stdout = JSON.stringify({
      structured_output: { title: "t", summary: "s", keywords: [] },
    });
    const msg = formatSpawnError(1, stdout, "real stderr message");
    assert.match(msg, /real stderr message/);
  });

  it("falls back to raw stdout when stderr is empty and stdout is non-json", () => {
    const msg = formatSpawnError(1, "raw garbage output", "");
    assert.match(msg, /raw garbage output/);
  });

  it("produces a useful message when both streams are empty", () => {
    const msg = formatSpawnError(1, "", "");
    assert.match(msg, /no error output/);
  });

  it("handles a null exit code (killed)", () => {
    const msg = formatSpawnError(null, "", "");
    assert.match(msg, /exited null/);
  });

  it("truncates a very long stderr fallback", () => {
    const long = "x".repeat(5000);
    const msg = formatSpawnError(1, "", long);
    // 500 chars cap, plus the prefix "...exited 1: "
    assert.ok(msg.length < 600);
  });
});

describe("buildSummarizeCliArgs", () => {
  it("puts the model after --model and the transcript last after -p", () => {
    const args = buildSummarizeCliArgs("the transcript", "sonnet");
    assert.equal(args[args.indexOf("--model") + 1], "sonnet");
    assert.equal(args[args.length - 2], "-p");
    assert.equal(args[args.length - 1], "the transcript");
  });

  it("requests strict json output against the summary schema and runs non-interactively", () => {
    const args = buildSummarizeCliArgs("x", "haiku");
    assert.ok(args.includes("--print"));
    assert.ok(args.includes("--no-session-persistence"));
    assert.equal(args[args.indexOf("--output-format") + 1], "json");
    assert.ok(args.includes("--json-schema"));
    // the schema arg is valid JSON carrying the title/summary/keywords shape
    const schemaArg = args[args.indexOf("--json-schema") + 1];
    assert.ok(schemaArg);
    const schema = JSON.parse(schemaArg);
    assert.deepEqual(Object.keys(schema.properties).sort(), ["keywords", "summary", "title"]);
  });
});
