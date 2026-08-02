import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  redactSettings,
  shortenHome,
  buildDiagnosticsReport,
  REDACTED_PRESENT,
  REDACTED_ABSENT,
  type DiagnosticsInput,
} from "../../../server/utils/diagnostics/report.js";
import { APP_SETTINGS_KEYS, SAFE_SETTINGS_KEYS } from "../../../server/system/config.js";

// The bug-report flow pastes this report into a public issue, so a leak here is
// a leak to the internet. The rules are an allow list on purpose: a setting
// added later must be withheld until someone judges it safe. These tests pin
// that direction of failure — the interesting case is not "does it print
// `chatIndex`" but "does an unrecognised key stay unprinted".

const SECRET = "AIzaSyD-not-a-real-key-0123456789";

describe("redactSettings", () => {
  it("prints allow-listed values verbatim", () => {
    const [entry] = redactSettings({ chatIndex: "haiku" }, ["chatIndex"]);
    assert.deepEqual(entry, { key: "chatIndex", value: "haiku", redacted: false });
  });

  it("withholds the plaintext Google Maps key", () => {
    const [entry] = redactSettings({ googleMapsApiKey: SECRET }, ["googleMapsApiKey"]);
    assert.ok(entry);
    assert.equal(entry.value, REDACTED_PRESENT);
    assert.equal(entry.redacted, true);
    assert.ok(!entry.value.includes(SECRET));
  });

  it("withholds a key nobody has classified yet", () => {
    // The regression that matters most: a future `AppSettings` field reaches
    // this function before anyone adds it to SAFE_SETTINGS_KEYS.
    const [entry] = redactSettings({ someFutureToken: SECRET }, ["someFutureToken"]);
    assert.ok(entry);
    assert.equal(entry.value, REDACTED_PRESENT);
    assert.equal(entry.redacted, true);
  });

  it("reports an absent key as not set rather than dropping it", () => {
    // "not set" IS the answer to most FAQ entries (the feature ships off), so
    // this line is the useful one, not noise.
    const [entry] = redactSettings({}, ["voiceInput"]);
    assert.deepEqual(entry, { key: "voiceInput", value: REDACTED_ABSENT, redacted: false });
  });

  it("does not mistake an inherited property for a present setting", () => {
    // A settings object parsed from JSON still inherits `constructor`; `in`
    // would report it present and the report would gain a phantom line.
    const [entry] = redactSettings({}, ["constructor"]);
    assert.ok(entry);
    assert.equal(entry.value, REDACTED_ABSENT);
  });

  it("renders non-string values as JSON", () => {
    const [toolsEntry, pushEntry] = redactSettings({ extraAllowedTools: ["mcp__claude_ai_Gmail"], pushEnabled: false }, ["extraAllowedTools", "pushEnabled"]);
    assert.ok(toolsEntry);
    assert.ok(pushEntry);
    assert.equal(toolsEntry.value, '["mcp__claude_ai_Gmail"]');
    assert.equal(pushEntry.value, "false");
  });

  it("still returns a string for values JSON cannot represent", () => {
    // `JSON.stringify` answers `undefined` for a function or symbol, which
    // would break the declared return type. Not reachable from a JSON settings
    // file, but the function accepts `unknown`.
    const rendered = redactSettings({ extraAllowedTools: () => "x", photoExif: Symbol("s") }, ["extraAllowedTools", "photoExif"]);
    rendered.forEach((entry) => assert.equal(typeof entry.value, "string"));
    assert.ok(!rendered.some((entry) => entry.value === "undefined"));
  });

  it("keeps the allow list a strict subset of the known keys", () => {
    const known = new Set<string>(APP_SETTINGS_KEYS);
    const strays = SAFE_SETTINGS_KEYS.filter((key) => !known.has(key));
    assert.deepEqual(strays, [], "a safe key that isn't an AppSettings key would never be read");
  });

  it("never allow-lists a key whose name looks secret", () => {
    const secretish = SAFE_SETTINGS_KEYS.filter((key) => /key|token|secret|password|credential/i.test(key));
    assert.deepEqual(secretish, [], "a key with a secret-shaped name must not be printed verbatim");
  });
});

describe("shortenHome", () => {
  it("replaces the home prefix everywhere it appears", () => {
    assert.equal(shortenHome("/Users/alice/mulmoclaude and /Users/alice/x", "/Users/alice"), "~/mulmoclaude and ~/x");
  });

  it("tolerates a trailing separator on the home path", () => {
    assert.equal(shortenHome("/Users/alice/ws", "/Users/alice/"), "~/ws");
    assert.equal(shortenHome("C:\\Users\\alice\\ws", "C:\\Users\\alice\\"), "~\\ws");
  });

  it("leaves text alone when home is empty or absent from it", () => {
    assert.equal(shortenHome("/opt/app", ""), "/opt/app");
    assert.equal(shortenHome("/opt/app", "/"), "/opt/app");
    assert.equal(shortenHome("/opt/app", "/Users/alice"), "/opt/app");
  });

  it("does not shorten a sibling directory that merely starts with home", () => {
    // A plain substring swap turned `/home/alice-archive` into `~-archive`.
    assert.equal(shortenHome("/home/alice-archive/x", "/home/alice"), "/home/alice-archive/x");
    assert.equal(shortenHome("/home/alicia/x", "/home/alice"), "/home/alicia/x");
  });

  it("does not shorten a different path that merely ends with the home path", () => {
    // Checking only the character AFTER a match rewrote `/tmp/home/alice/ws`
    // to `/tmp~/ws`: the match has to be bounded on the left too.
    assert.equal(shortenHome("/tmp/home/alice/ws", "/home/alice"), "/tmp/home/alice/ws");
    assert.equal(shortenHome("foo/home/alice bar", "/home/alice"), "foo/home/alice bar");
    assert.equal(shortenHome("/mnt/backup/home/alice", "/home/alice"), "/mnt/backup/home/alice");
  });

  it("shortens home when prose opens the path", () => {
    // The left boundary must not be so strict that a wrapped path leaks.
    assert.equal(shortenHome("(/home/alice/x)", "/home/alice"), "(~/x)");
    assert.equal(shortenHome('"/home/alice"', "/home/alice"), '"~"');
    assert.equal(shortenHome("Workspace: /home/alice/ws", "/home/alice"), "Workspace: ~/ws");
  });

  it("treats a separator as an end boundary but never as a start one", () => {
    // The asymmetry is deliberate and easy to undo: `/home/alice` + `/ws` is
    // the home directory, but `x/` + `/home/alice` is not — a separator before
    // the match means the home path is the tail of a longer one. Adding a
    // separator to PATH_START_RE would look symmetrical and be wrong.
    assert.equal(shortenHome("/home/alice/ws", "/home/alice"), "~/ws");
    assert.equal(shortenHome("x//home/alice", "/home/alice"), "x//home/alice");
  });

  it("treats a closing bracket as an end boundary but never an opening one", () => {
    // The mirror asymmetry, and the one a future "make the two lists match"
    // cleanup would break: prose wraps a path as `(/home/alice)`, so an opener
    // may START a path — but a directory can genuinely be named `alice(x)`, so
    // an opener may never END one.
    assert.equal(shortenHome("(/home/alice)", "/home/alice"), "(~)");
    assert.equal(shortenHome("/home/alice(x)/ws", "/home/alice"), "/home/alice(x)/ws");
  });

  it("reads both boundaries from the input, not from its own partial output", () => {
    // Once the first match becomes `~`, the characters around a later match no
    // longer describe the input. `~/home/alice` is the right answer here: a
    // directory literally named `home/alice` beneath the user's home.
    assert.equal(shortenHome("/home/alice/home/alice", "/home/alice"), "~/home/alice");
  });

  it("does not shorten siblings using punctuation that is legal in a directory name", () => {
    // The first fix classified path characters as `[\w.-]`, which mangled every
    // sibling built with anything else. Almost any byte is legal in a directory
    // name, so the rule keys off delimiters instead.
    ["+archive", "@work", "~backup", "(old)", "&co", "!tmp", "%2f", "=v2", "#1"].forEach((suffix) => {
      const text = `/home/alice${suffix}/x`;
      assert.equal(shortenHome(text, "/home/alice"), text, `mis-shortened /home/alice${suffix}`);
    });
  });

  it("shortens home itself, with or without a trailing path", () => {
    assert.equal(shortenHome("/home/alice", "/home/alice"), "~");
    assert.equal(shortenHome("/home/alice/ws", "/home/alice"), "~/ws");
    assert.equal(shortenHome("at /home/alice, and /home/alice/ws", "/home/alice"), "at ~, and ~/ws");
  });

  it("shortens some occurrences while leaving non-boundary ones intact", () => {
    assert.equal(shortenHome("/home/alice/ws and /home/alice-old/ws", "/home/alice"), "~/ws and /home/alice-old/ws");
  });

  it("still shortens home where a sentence ends the path", () => {
    // The other failure direction, and the more serious one: leaving the path
    // unshortened publishes the account name. Pinned alongside the sibling
    // cases above so a future fix for one cannot silently reintroduce the other.
    [",", ";", " ", '"', "'", "`", ")", "]", ">", "|"].forEach((delimiter) => {
      assert.equal(shortenHome(`at /home/alice${delimiter}x`, "/home/alice"), `at ~${delimiter}x`, `left home unshortened before ${JSON.stringify(delimiter)}`);
    });
  });

  it("does not shred every path when home is the root", () => {
    // `/` as home would match at every separator and destroy the report.
    assert.equal(shortenHome("/a/b/c", "/"), "/a/b/c");
  });
});

const input = (overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  appVersion: "1.5.0",
  nodeVersion: "v22.0.0",
  platform: "darwin",
  arch: "arm64",
  home: "/Users/alice",
  sandboxEnabled: true,
  sandboxMounts: ["gh"],
  sshAgentForwarded: true,
  settings: { chatIndex: "haiku", googleMapsApiKey: SECRET },
  mcpServerNames: ["my-server"],
  pluginDiagnostics: [],
  workspacePath: "/Users/alice/mulmoclaude",
  ...overrides,
});

describe("buildDiagnosticsReport", () => {
  it("produces the same bytes for the same input", () => {
    assert.equal(buildDiagnosticsReport(input()), buildDiagnosticsReport(input()));
  });

  it("never contains a secret value", () => {
    assert.ok(!buildDiagnosticsReport(input()).includes(SECRET));
  });

  it("shortens the home directory out of every path", () => {
    const report = buildDiagnosticsReport(input());
    assert.ok(!report.includes("/Users/alice"), "an absolute path leaks the account name");
    assert.ok(report.includes("~/mulmoclaude"));
  });

  it("lists every known setting so a reader can see what wasn't set", () => {
    const report = buildDiagnosticsReport(input({ settings: {} }));
    APP_SETTINGS_KEYS.forEach((key) => assert.ok(report.includes(`\`${key}\``), `${key} missing from the report`));
  });

  it("names MCP servers without their specs", () => {
    // `env` / `headers` on a stdio server hold provider tokens; only the id is
    // safe to publish, and the input type is what enforces it.
    const report = buildDiagnosticsReport(input({ mcpServerNames: ["notion", "linear"] }));
    assert.ok(report.includes("`notion`") && report.includes("`linear`"));
  });

  it("says so explicitly when a list is empty", () => {
    const report = buildDiagnosticsReport(input({ sandboxMounts: [], mcpServerNames: [], pluginDiagnostics: [] }));
    assert.ok(report.includes("no config mounts"));
    assert.ok(report.includes("none registered"));
    assert.ok(report.includes("no collisions reported"));
  });

  it("reports a disabled sandbox as such", () => {
    const report = buildDiagnosticsReport(input({ sandboxEnabled: false, sandboxMounts: [], sshAgentForwarded: false }));
    assert.ok(report.includes("- enabled: no"));
  });

  it("ends with a single trailing newline", () => {
    const report = buildDiagnosticsReport(input());
    assert.ok(report.endsWith("\n"));
    assert.ok(!report.endsWith("\n\n"));
  });
});
