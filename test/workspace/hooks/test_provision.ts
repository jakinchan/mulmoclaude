// Unit tests for the unified dispatcher provisioner.
//
// Coverage:
//   - First install: writes the dispatcher script + one settings.json
//     entry tagged with the owner marker.
//   - Idempotent: second run produces byte-identical output.
//   - Legacy migration: pre-unification entries (wikiHistory,
//     configRefresh markers) are removed and replaced with the single
//     dispatcher entry.
//   - Non-destructive: user-supplied keys, hooks without a marker,
//     and unrelated PostToolUse entries are preserved.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OWNER_MARKER, provisionDispatcherHook, upsertDispatcherEntry } from "../../../server/workspace/hooks/provision.js";
import { isRecord, isUnknownArray } from "../../../server/utils/types.js";

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; [marker: string]: unknown }[];
}

interface SettingsShape {
  hooks?: { PostToolUse?: HookEntry[] };
  [key: string]: unknown;
}

async function readSettings(workspace: string): Promise<SettingsShape> {
  const raw = await readFile(path.join(workspace, ".claude", "settings.json"), "utf-8");
  return JSON.parse(raw) as SettingsShape;
}

describe("provisionDispatcherHook — first install", () => {
  it("writes the dispatcher script and registers the PostToolUse entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hooks-prov-fresh-"));
    // The provisioner needs `.claude/` and `.claude/hooks/` to
    // exist before writeFileAtomic — real startup goes through
    // ensureDir higher up the stack; mirror that here.
    await mkdir(path.join(root, ".claude", "hooks"), { recursive: true });
    await provisionDispatcherHook({ workspaceRoot: root });

    const settings = await readSettings(root);
    const entries = settings.hooks?.PostToolUse ?? [];
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry);
    assert.equal(entry.matcher, "Write|Edit|Bash");
    const [hook] = entry.hooks ?? [];
    assert.ok(hook);
    assert.equal(hook.type, "command");
    // Command must use $CLAUDE_PROJECT_DIR so the same settings.json
    // works on the host AND inside the Docker container, where the
    // workspace lives at a different absolute path.
    assert.match(hook.command ?? "", /node "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/mulmoclaude-dispatcher\.mjs"/);
    assert.equal(hook[OWNER_MARKER], true);

    const scriptBody = await readFile(path.join(root, ".claude", "hooks", "mulmoclaude-dispatcher.mjs"), "utf-8");
    // Anchor on the shebang and a substring from the bundled
    // handlers — both survive any future bundle reformatting.
    assert.match(scriptBody, /^#!\/usr\/bin\/env node/);
    assert.match(scriptBody, /\/api\/config\/refresh/);
    assert.match(scriptBody, /\/api\/wiki\/internal\/snapshot/);

    await rm(root, { recursive: true, force: true });
  });
});

describe("provisionDispatcherHook — idempotent", () => {
  it("running twice produces byte-identical settings + script", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hooks-prov-idem-"));
    await mkdir(path.join(root, ".claude", "hooks"), { recursive: true });
    await provisionDispatcherHook({ workspaceRoot: root });
    const firstSettings = await readFile(path.join(root, ".claude", "settings.json"), "utf-8");
    const firstScript = await readFile(path.join(root, ".claude", "hooks", "mulmoclaude-dispatcher.mjs"), "utf-8");

    await provisionDispatcherHook({ workspaceRoot: root });
    const secondSettings = await readFile(path.join(root, ".claude", "settings.json"), "utf-8");
    const secondScript = await readFile(path.join(root, ".claude", "hooks", "mulmoclaude-dispatcher.mjs"), "utf-8");

    assert.equal(firstSettings, secondSettings);
    assert.equal(firstScript, secondScript);

    await rm(root, { recursive: true, force: true });
  });
});

describe("provisionDispatcherHook — legacy migration", () => {
  it("removes pre-unification owner entries and replaces them with the dispatcher", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hooks-prov-migrate-"));
    await mkdir(path.join(root, ".claude", "hooks"), { recursive: true });
    const legacy = {
      hooks: {
        PostToolUse: [
          // Legacy wiki-history entry — should be stripped.
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/wiki-snapshot.mjs"', mulmoclaudeWikiHistory: true }],
          },
          // Legacy config-refresh entry — should be stripped.
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/config-refresh.mjs"', mulmoclaudeConfigRefresh: true }],
          },
          // Unrelated user-owned entry — must survive.
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo user-hook" }],
          },
        ],
      },
      customKey: "user-value",
    };
    await writeFile(path.join(root, ".claude", "settings.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");

    await provisionDispatcherHook({ workspaceRoot: root });

    const settings = await readSettings(root);
    const entries = settings.hooks?.PostToolUse ?? [];
    // Two entries left: the user-owned `echo user-hook` and the
    // dispatcher. The two legacy MulmoClaude entries are gone.
    assert.equal(entries.length, 2);
    const userEntry = entries.find((entry) => entry.matcher === "Bash");
    assert.ok(userEntry, "user-owned Bash entry must survive");
    assert.equal(userEntry?.hooks?.[0]?.command, "echo user-hook");
    const dispatcherEntry = entries.find((entry) => entry.hooks?.[0]?.[OWNER_MARKER] === true);
    assert.ok(dispatcherEntry, "dispatcher entry must be present");

    // Unrelated top-level key untouched.
    assert.equal(settings.customKey, "user-value");

    await rm(root, { recursive: true, force: true });
  });
});

describe("provisionDispatcherHook — descriptor-level stripping", () => {
  it("preserves user-owned hook descriptors that share an entry with a MulmoClaude marker", async () => {
    // Codex regression: previously the migration filtered at the
    // entry level (whole HookMatcher), so a user-owned descriptor
    // co-located in the same matcher as our legacy entry was
    // silently deleted. The fix strips descriptors individually.
    const root = await mkdtemp(path.join(tmpdir(), "hooks-prov-mixed-"));
    await mkdir(path.join(root, ".claude", "hooks"), { recursive: true });
    const mixed = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [
              // User's own hook — must survive.
              { type: "command", command: "node my-formatter.mjs" },
              // Legacy MulmoClaude entry — must be stripped.
              { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/wiki-snapshot.mjs"', mulmoclaudeWikiHistory: true },
              // Another user hook — must survive.
              { type: "command", command: "node my-tracker.mjs" },
            ],
          },
        ],
      },
    };
    await writeFile(path.join(root, ".claude", "settings.json"), `${JSON.stringify(mixed, null, 2)}\n`, "utf-8");

    await provisionDispatcherHook({ workspaceRoot: root });

    const settings = await readSettings(root);
    const entries = settings.hooks?.PostToolUse ?? [];
    // Two entries left: the surviving mixed entry (user hooks only)
    // and the appended dispatcher entry.
    assert.equal(entries.length, 2);
    const survivingMixed = entries.find((entry) => entry.matcher === "Write|Edit");
    assert.ok(survivingMixed, "mixed user/MC entry must survive when user descriptors remain");
    const commands = (survivingMixed.hooks ?? []).map((hook) => hook.command);
    assert.deepEqual(commands, ["node my-formatter.mjs", "node my-tracker.mjs"]);

    await rm(root, { recursive: true, force: true });
  });

  it("drops the entry entirely when stripping leaves the hooks array empty", async () => {
    // A pre-unification entry that contained ONLY our legacy hook
    // (no user siblings) has nothing left after stripping. Keep
    // an empty `hooks: []` would be a schema-noise file; drop the
    // entry.
    const root = await mkdtemp(path.join(tmpdir(), "hooks-prov-empty-"));
    await mkdir(path.join(root, ".claude", "hooks"), { recursive: true });
    const onlyOurs = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/wiki-snapshot.mjs"', mulmoclaudeWikiHistory: true }],
          },
        ],
      },
    };
    await writeFile(path.join(root, ".claude", "settings.json"), `${JSON.stringify(onlyOurs, null, 2)}\n`, "utf-8");

    await provisionDispatcherHook({ workspaceRoot: root });

    const settings = await readSettings(root);
    const entries = settings.hooks?.PostToolUse ?? [];
    // Just the dispatcher entry — the now-empty Write|Edit entry
    // is gone, not a no-hooks zombie.
    assert.equal(entries.length, 1);
    const [dispatcherEntry] = entries;
    assert.ok(dispatcherEntry);
    const [dispatcherHook] = dispatcherEntry.hooks ?? [];
    assert.ok(dispatcherHook);
    assert.equal(dispatcherHook[OWNER_MARKER], true);

    await rm(root, { recursive: true, force: true });
  });
});

/** The provisioner models the settings tree as `Record<string, unknown>` (it is
 *  the user's own file), so the assertions narrow the branch they read. */
function postToolUseEntries(settings: Record<string, unknown>): unknown[] {
  const { hooks } = settings;
  const entries = isRecord(hooks) ? hooks.PostToolUse : undefined;
  if (!isUnknownArray(entries)) assert.fail("settings.hooks.PostToolUse is not an array");
  return entries;
}

describe("upsertDispatcherEntry — pure helper", () => {
  it("dedupes our own marker on repeated calls", () => {
    const first = upsertDispatcherEntry({});
    const second = upsertDispatcherEntry(first);
    // Both passes produce settings with exactly one dispatcher
    // entry — the helper recognises its own marker.
    assert.equal(postToolUseEntries(second).length, 1);
  });

  it("normalises a malformed PostToolUse field without throwing", () => {
    // A corrupted on-disk shape (string instead of array) — exactly the
    // scenario this test is meant to cover.
    const next = upsertDispatcherEntry({ hooks: { PostToolUse: "not-an-array" } });
    const entries = postToolUseEntries(next);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    if (!isRecord(entry) || !isUnknownArray(entry.hooks)) assert.fail("dispatcher entry carries no hooks array");
    const [descriptor] = entry.hooks;
    if (!isRecord(descriptor)) assert.fail("dispatcher descriptor is not an object");
    assert.equal(descriptor[OWNER_MARKER], true);
  });
});
