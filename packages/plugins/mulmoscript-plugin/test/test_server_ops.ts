import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { FileOps } from "gui-chat-protocol";
import type { MulmoBeat } from "@mulmocast/types";
import { buildBeatIdIndex, createMulmoScriptServerOps, type StoryContext } from "../src/server/ops";
import type { OpResult } from "../src/server/types";

// Ported from MulmoClaude's test/routes/test_mulmoScriptHelpers.ts when the
// ops layer moved into this package (phase 3). `runStoryOp`'s `deps` param
// lets these tests run without the full mulmocast stack.

const stubFileOps: FileOps = {
  read: async () => {
    throw new Error("unused");
  },
  readBytes: async () => new Uint8Array(),
  write: async () => {},
  readDir: async () => [],
  stat: async () => ({ mtimeMs: 0, size: 0 }),
  exists: async () => false,
  unlink: async () => {},
};

function makeOps() {
  return createMulmoScriptServerOps({
    storiesDir: "/nonexistent/for-tests/artifacts/stories",
    artifacts: stubFileOps,
    writeFileAtomic: async () => {},
  });
}

// buildBeatIdIndex only reads `beat.id`; the fixtures pass partial
// beats cast to MulmoBeat (same convention as fakeContext below).
const beats = (...ids: (string | undefined)[]): MulmoBeat[] => ids.map((beatId) => ({ id: beatId }) as unknown as MulmoBeat);

// A minimal stand-in for the mulmo studio context. `runStoryOp`
// treats it as an opaque value — it only checks truthiness and passes
// the reference to the handler.
const fakeContext = { studio: { script: {} } } as unknown as StoryContext;

const resolveOk = () => ({ ok: true, absolutePath: "/abs/stories/x.json" }) as const;

describe("runStoryOp — resolver rejects filePath", () => {
  it("short-circuits without calling buildContext or handler", async () => {
    const ops = makeOps();
    let buildCalled = false;
    let handlerCalled = false;
    const result = await ops.runStoryOp(
      "bad",
      {},
      async () => {
        handlerCalled = true;
        return { ok: true };
      },
      {
        resolveStory: () => ({ ok: false, code: "bad_request", error: "bad" }),
        buildContext: async () => {
          buildCalled = true;
          return fakeContext;
        },
      },
    );
    assert.equal(handlerCalled, false);
    assert.equal(buildCalled, false);
    assert.deepEqual(result, { ok: false, code: "bad_request", error: "bad" });
  });
});

describe("runStoryOp — buildContext returns undefined", () => {
  it("returns server_error with the standard mulmo-context message", async () => {
    const ops = makeOps();
    let handlerCalled = false;
    const result = await ops.runStoryOp(
      "stories/x.json",
      {},
      async () => {
        handlerCalled = true;
        return { ok: true };
      },
      {
        resolveStory: resolveOk,
        buildContext: async () => undefined,
      },
    );
    assert.equal(handlerCalled, false);
    assert.deepEqual(result, { ok: false, code: "server_error", error: "Failed to initialize mulmo context" });
  });

  it("uses onContextMissing override to emit a soft-fail payload", async () => {
    // Some ops (e.g. beatAudio) historically return an ok
    // `{ audio: null }` when the workspace context can't be
    // initialised yet, so the frontend can silently retry. The
    // override must bypass the default server_error.
    const ops = makeOps();
    let handlerCalled = false;
    const result: OpResult<{ audio: string | null }> = await ops.runStoryOp<{ audio: string | null }>(
      "stories/x.json",
      {
        onContextMissing: () => ({ ok: true, audio: null }),
      },
      async () => {
        handlerCalled = true;
        return { ok: true, audio: "unreachable" };
      },
      {
        resolveStory: resolveOk,
        buildContext: async () => undefined,
      },
    );
    assert.equal(handlerCalled, false);
    assert.deepEqual(result, { ok: true, audio: null });
  });
});

describe("runStoryOp — handler throws", () => {
  it("catches the error and returns server_error with its message", async () => {
    const ops = makeOps();
    const result = await ops.runStoryOp(
      "stories/x.json",
      {},
      async () => {
        throw new Error("boom");
      },
      {
        resolveStory: resolveOk,
        buildContext: async () => fakeContext,
      },
    );
    assert.deepEqual(result, { ok: false, code: "server_error", error: "boom" });
  });

  it("handles a non-Error thrown value", async () => {
    const ops = makeOps();
    const result = await ops.runStoryOp(
      "stories/x.json",
      {},
      async () => {
        // intentional non-Error throw — asserting runStoryOp converts unknown rejections to server_error
        throw "plain string";
      },
      {
        resolveStory: resolveOk,
        buildContext: async () => fakeContext,
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /plain string/);
  });
});

describe("runStoryOp — happy path", () => {
  it("invokes handler with absoluteFilePath and context and returns its result", async () => {
    const ops = makeOps();
    const received: { absoluteFilePath?: string; context?: unknown } = {};
    const result = await ops.runStoryOp(
      "stories/x.json",
      {},
      async ({ absoluteFilePath, context }) => {
        received.absoluteFilePath = absoluteFilePath;
        received.context = context;
        return { ok: true, image: "data:image/png;base64,AAAA" };
      },
      {
        resolveStory: resolveOk,
        buildContext: async () => fakeContext,
      },
    );
    assert.equal(received.absoluteFilePath, "/abs/stories/x.json");
    assert.equal(received.context, fakeContext);
    assert.deepEqual(result, { ok: true, image: "data:image/png;base64,AAAA" });
  });

  it("forwards the force option to buildContext", async () => {
    const ops = makeOps();
    let seenForce: boolean | undefined;
    await ops.runStoryOp("stories/x.json", { force: true }, async () => ({ ok: true }), {
      resolveStory: resolveOk,
      buildContext: async (_fp, force) => {
        seenForce = force;
        return fakeContext;
      },
    });
    assert.equal(seenForce, true);
  });

  it("defaults force to false when option is omitted", async () => {
    const ops = makeOps();
    let seenForce: boolean | undefined;
    await ops.runStoryOp("stories/x.json", {}, async () => ({ ok: true }), {
      resolveStory: resolveOk,
      buildContext: async (_fp, force) => {
        seenForce = force;
        return fakeContext;
      },
    });
    assert.equal(seenForce, false);
  });
});

describe("generation tracker — edge-triggered publish + snapshot", () => {
  it("publishes first start / last finish only for duplicate runs", () => {
    const events: { done: boolean; key: string }[] = [];
    const ops = createMulmoScriptServerOps({
      storiesDir: "/nonexistent/for-tests/artifacts/stories",
      artifacts: stubFileOps,
      writeFileAtomic: async () => {},
      onGenerationEvent: (_sessionId, event) => events.push({ done: event.done, key: event.key }),
    });
    ops.publishGeneration(undefined, "beatImage", "stories/x.json", "3", false);
    ops.publishGeneration(undefined, "beatImage", "stories/x.json", "3", false); // duplicate start — suppressed
    assert.equal(events.length, 1);
    assert.deepEqual(ops.pendingGenerations("stories/x.json"), [{ kind: "beatImage", filePath: "stories/x.json", key: "3", done: false }]);

    ops.publishGeneration(undefined, "beatImage", "stories/x.json", "3", true); // first finish — suppressed (duplicate active)
    assert.equal(events.length, 1);
    assert.equal(ops.pendingGenerations("stories/x.json").length, 1);

    ops.publishGeneration(undefined, "beatImage", "stories/x.json", "3", true); // last finish — published
    assert.equal(events.length, 2);
    const [, lastEvent] = events;
    assert.ok(lastEvent);
    assert.equal(lastEvent.done, true);
    assert.equal(ops.pendingGenerations("stories/x.json").length, 0);
  });

  it("passes finish-only pulses through (no tracked start)", () => {
    const events: boolean[] = [];
    const ops = createMulmoScriptServerOps({
      storiesDir: "/nonexistent/for-tests/artifacts/stories",
      artifacts: stubFileOps,
      writeFileAtomic: async () => {},
      onGenerationEvent: (_sessionId, event) => events.push(event.done),
    });
    ops.publishGeneration(undefined, "beatAudio", "stories/x.json", "0", true);
    assert.deepEqual(events, [true]);
  });

  it("keys tracker state and events on the canonical wire path for alias spellings", () => {
    const events: string[] = [];
    const ops = createMulmoScriptServerOps({
      storiesDir: "/nonexistent/for-tests/artifacts/stories",
      artifacts: stubFileOps,
      writeFileAtomic: async () => {},
      onGenerationEvent: (_sessionId, event) => events.push(event.filePath),
    });
    // Start under the artifacts/stories alias: the event and the
    // snapshot must both surface the canonical form so canonical
    // subscribers (the View) see them.
    ops.publishGeneration(undefined, "beatImage", "artifacts/stories/x.json", "3", false);
    assert.deepEqual(events, ["stories/x.json"]);
    assert.deepEqual(ops.pendingGenerations("stories/x.json"), [{ kind: "beatImage", filePath: "stories/x.json", key: "3", done: false }]);
    // The snapshot filter accepts the alias too.
    assert.equal(ops.pendingGenerations("artifacts/stories/x.json").length, 1);

    // A canonical-spelled start of the SAME work item dedupes against the
    // alias-spelled one (same physical generation), and its finish
    // clears the shared entry.
    ops.publishGeneration(undefined, "beatImage", "stories/x.json", "3", false); // duplicate start — suppressed
    assert.equal(events.length, 1);
    ops.publishGeneration(undefined, "beatImage", "stories/x.json", "3", true); // first finish — suppressed
    ops.publishGeneration(undefined, "beatImage", "artifacts/stories/x.json", "3", true); // last finish — published, canonical
    assert.deepEqual(events, ["stories/x.json", "stories/x.json"]);
    assert.equal(ops.pendingGenerations("stories/x.json").length, 0);
  });

  it("dedupes the same physical work item across different chat sessions", () => {
    // The tracker keys on kind/filePath/key ONLY — two sessions rendering
    // the same beat of the same file are the same physical generation, so
    // the second start is suppressed and the surviving finish carries the
    // finishing caller's session tag.
    const events: { sessionId: string | undefined; done: boolean }[] = [];
    const ops = createMulmoScriptServerOps({
      storiesDir: "/nonexistent/for-tests/artifacts/stories",
      artifacts: stubFileOps,
      writeFileAtomic: async () => {},
      onGenerationEvent: (sessionId, event) => events.push({ sessionId, done: event.done }),
    });
    ops.publishGeneration("session-a", "beatImage", "stories/x.json", "3", false);
    ops.publishGeneration("session-b", "beatImage", "stories/x.json", "3", false); // same work item — suppressed
    ops.publishGeneration("session-b", "beatImage", "stories/x.json", "3", true); // first finish — suppressed (count 2→1)
    ops.publishGeneration("session-a", "beatImage", "stories/x.json", "3", true); // last finish — published
    assert.deepEqual(events, [
      { sessionId: "session-a", done: false },
      { sessionId: "session-a", done: true },
    ]);
    assert.equal(ops.pendingGenerations("stories/x.json").length, 0);
  });

  it("a finish-only pipeline pulse consumes an actively tracked same-key entry", () => {
    // Documented semantics: the tracker cannot distinguish a movie
    // pipeline's per-beat completion pulse from a tracked manual render's
    // finish — a colliding pulse decrements the tracked entry (here:
    // count 1 → delete + publish done). The View reloads the asset either
    // way; the manual render's own finish then passes through as a
    // second, untracked done pulse.
    const events: boolean[] = [];
    const ops = createMulmoScriptServerOps({
      storiesDir: "/nonexistent/for-tests/artifacts/stories",
      artifacts: stubFileOps,
      writeFileAtomic: async () => {},
      onGenerationEvent: (_sessionId, event) => events.push(event.done),
    });
    ops.publishGeneration(undefined, "beatImage", "stories/x.json", "1", false); // manual render start
    ops.publishGeneration(undefined, "beatImage", "stories/x.json", "1", true); // pipeline pulse — consumes the entry
    assert.deepEqual(events, [false, true]);
    assert.equal(ops.pendingGenerations("stories/x.json").length, 0);
    ops.publishGeneration(undefined, "beatImage", "stories/x.json", "1", true); // manual render's own finish — untracked pulse
    assert.deepEqual(events, [false, true, true]);
  });
});

describe("buildBeatIdIndex", () => {
  it("maps each beat's id to its array index", () => {
    const index = buildBeatIdIndex(beats("intro", "body", "outro"));
    assert.deepEqual(
      [...index.entries()],
      [
        ["intro", 0],
        ["body", 1],
        ["outro", 2],
      ],
    );
  });

  it("falls back to __index__<n> for id-less beats", () => {
    const index = buildBeatIdIndex(beats(undefined, undefined));
    assert.equal(index.get("__index__0"), 0);
    assert.equal(index.get("__index__1"), 1);
  });

  it("mixes explicit ids and synthetic fallbacks", () => {
    const index = buildBeatIdIndex(beats("intro", undefined, "outro"));
    assert.equal(index.get("intro"), 0);
    assert.equal(index.get("__index__1"), 1);
    assert.equal(index.get("outro"), 2);
  });

  it("returns an empty map for no beats", () => {
    assert.equal(buildBeatIdIndex([]).size, 0);
  });

  it("keeps the last index when beats share an id", () => {
    const index = buildBeatIdIndex(beats("dup", "dup"));
    assert.equal(index.size, 1);
    assert.equal(index.get("dup"), 1);
  });
});

describe("resolveStory — wire path spellings", () => {
  // Real temp dir: resolveStory realpaths the stories dir and requires
  // the target to exist, so the stub storiesDir used above won't do.
  function makeRealOps() {
    const workspace = mkdtempSync(path.join(tmpdir(), "mulmoscript-resolve-"));
    const storiesDir = path.join(workspace, "artifacts", "stories");
    mkdirSync(storiesDir, { recursive: true });
    writeFileSync(path.join(storiesDir, "foo.json"), "{}");
    return createMulmoScriptServerOps({ storiesDir, artifacts: stubFileOps, writeFileAtomic: async () => {} });
  }

  it("resolves canonical, bare, and workspace-relative spellings to the same file", () => {
    const ops = makeRealOps();
    const canonical = ops.resolveStory("stories/foo.json");
    assert.ok(canonical.ok);
    for (const spelling of ["foo.json", "artifacts/stories/foo.json"]) {
      const resolved = ops.resolveStory(spelling);
      assert.ok(resolved.ok, `expected ${spelling} to resolve`);
      assert.equal(resolved.absolutePath, canonical.absolutePath);
    }
  });

  it("still rejects traversal under the artifacts/stories spelling", () => {
    const ops = makeRealOps();
    const resolved = ops.resolveStory("artifacts/stories/../../secret.json");
    assert.equal(resolved.ok, false);
  });

  it("404s a missing file under the artifacts/stories spelling", () => {
    const ops = makeRealOps();
    const resolved = ops.resolveStory("artifacts/stories/missing.json");
    assert.ok(!resolved.ok);
    assert.equal(resolved.code, "not_found");
  });

  it("rejects base directory spellings with no file remainder", () => {
    const ops = makeRealOps();
    for (const spelling of ["stories", "stories/", "artifacts/stories", "artifacts/stories/"]) {
      const resolved = ops.resolveStory(spelling);
      assert.ok(!resolved.ok, `expected ${spelling} to be rejected`);
      assert.equal(resolved.code, "bad_request");
    }
  });
});
