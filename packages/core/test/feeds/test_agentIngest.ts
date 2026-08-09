// Importing for these named bindings also runs _setup's host-configuration side
// effects (collection + feeds hosts), so no separate side-effect import is needed.
import { setTestWorker, resetNotifierForTest } from "./_setup.ts";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

import path from "node:path";
import { refreshViaAgent, readFeedState, type AgentWorkerResult } from "../../src/feeds/server/index.ts";
import type { LoadedCollection } from "../../src/collection/server/index.ts";
import { makeTempDir } from "../helpers/tempDir.js";

// Hand-build a skill-backed collection with agent ingest. `withTemplate`
// controls whether the on-disk template exists (the missing-template path).
function makeAgentCollection(root: string, slug: string, withTemplate: boolean): LoadedCollection {
  const skillDir = path.join(root, ".claude", "skills", slug);
  const dataDir = path.join(root, "data", slug);
  mkdirSync(dataDir, { recursive: true });
  if (withTemplate) {
    mkdirSync(path.join(skillDir, "templates"), { recursive: true });
    writeFileSync(path.join(skillDir, "templates", "refresh.md"), "Refresh each record. Edit and stop.\n");
  }
  return {
    slug,
    source: "user",
    schema: {
      title: "Quotes",
      icon: "trending_up",
      dataPath: `data/${slug}`,
      primaryKey: "id",
      fields: { id: { type: "string", label: "ID", primary: true } },
      ingest: { kind: "agent", schedule: "daily", role: "investor", template: "templates/refresh.md" },
    },
    dataDir,
    skillDir,
  } as unknown as LoadedCollection;
}

beforeEach(() => {
  // The failure path publishes/clears a notifier bell — point the engine at
  // fresh temp files with a no-op pub-sub so publish/clear don't throw.
  resetNotifierForTest();
});

describe("refreshViaAgent — dispatch", () => {
  it("dispatches a worker and stamps lastFetchedAt on a successful launch", async () => {
    const root = makeTempDir("agent-ingest-");
    const collection = makeAgentCollection(root, "quotes-ok", true);
    let seenRole: string | null = null;
    let seenHidden: boolean | undefined;
    setTestWorker(async (args): Promise<AgentWorkerResult> => {
      seenRole = args.roleId;
      seenHidden = args.hidden;
      return { ok: true, chatId: "chat-1" };
    });

    const result = await refreshViaAgent(root, collection);
    assert.equal(result.dispatched, true);
    assert.equal(result.errors.length, 0);
    assert.equal(seenRole, "investor", "worker runs in the ingest role");
    assert.equal(seenHidden, true, "scheduled refresh runs a hidden worker by default");

    const state = await readFeedState(root, collection);
    assert.ok(state.lastFetchedAt, "lastFetchedAt stamped at dispatch time");
  });

  it("runs a VISIBLE worker with no completion hook when hidden:false (manual Refresh)", async () => {
    const root = makeTempDir("agent-ingest-");
    const collection = makeAgentCollection(root, "quotes-manual", true);
    let seenHidden: boolean | undefined;
    let seenOnComplete: unknown = "unset";
    setTestWorker(async (args): Promise<AgentWorkerResult> => {
      seenHidden = args.hidden;
      seenOnComplete = args.onComplete;
      return { ok: true, chatId: "chat-manual" };
    });

    const result = await refreshViaAgent(root, collection, { hidden: false });
    assert.equal(result.dispatched, true);
    assert.equal(seenHidden, false, "manual refresh runs a visible session");
    assert.equal(seenOnComplete, undefined, "a visible run carries no completion hook (the user watches it)");
  });

  it("leaves state untouched and reports the error on a cap-miss", async () => {
    const root = makeTempDir("agent-ingest-");
    const collection = makeAgentCollection(root, "quotes-cap", true);
    setTestWorker(async (): Promise<AgentWorkerResult> => ({ ok: false, error: "too many background sessions" }));

    const result = await refreshViaAgent(root, collection);
    assert.equal(result.dispatched, false);
    assert.equal(result.errors.length, 1);

    const state = await readFeedState(root, collection);
    assert.equal(state.lastFetchedAt, null, "no dispatch ⇒ no lastFetchedAt, so the next tick retries");
  });

  it("forwards the root it was called with, so a multi-root host spawns the worker THERE", async () => {
    const root = makeTempDir("agent-ingest-");
    const collection = makeAgentCollection(root, "quotes-root", true);
    let seenRoot: string | undefined = "unset";
    setTestWorker(async (args): Promise<AgentWorkerResult> => {
      seenRoot = args.workspaceRoot;
      return { ok: true, chatId: "chat-root" };
    });

    await refreshViaAgent(root, collection);
    // The seed prompt's `dataPath` is relative to this root; without it the
    // worker would resolve it against whichever root it happens to run in.
    assert.equal(seenRoot, root, "the refresh's root reaches the runner");
  });

  it("dispatches through a runner that never declares workspaceRoot (the single-workspace shape)", async () => {
    const root = makeTempDir("agent-ingest-");
    const collection = makeAgentCollection(root, "quotes-legacy", true);
    // Deliberately destructures only the fields a single-workspace host reads —
    // the extra argument must be inert, not a break.
    setTestWorker(async ({ message, roleId }): Promise<AgentWorkerResult> => {
      assert.ok(message.length > 0);
      assert.equal(roleId, "investor");
      return { ok: true, chatId: "chat-legacy" };
    });

    const result = await refreshViaAgent(root, collection);
    assert.equal(result.dispatched, true);
    const state = await readFeedState(root, collection);
    assert.ok(state.lastFetchedAt, "lastFetchedAt stamped exactly as before");
  });

  it("reports a missing template without dispatching", async () => {
    const root = makeTempDir("agent-ingest-");
    const collection = makeAgentCollection(root, "quotes-notmpl", false);
    let launched = false;
    setTestWorker(async (): Promise<AgentWorkerResult> => {
      launched = true;
      return { ok: true, chatId: "chat-x" };
    });

    const result = await refreshViaAgent(root, collection);
    assert.equal(result.dispatched, undefined);
    assert.equal(result.errors.length, 1);
    assert.equal(launched, false, "no worker launched when the template can't be read");
  });
});

describe("refreshViaAgent — completion outcome", () => {
  it("increments consecutiveFailures and raises a bell on error, then clears on success", async () => {
    const root = makeTempDir("agent-ingest-");
    const collection = makeAgentCollection(root, "quotes-outcome", true);
    let onComplete: ((o: { didError: boolean }) => void | Promise<void>) | undefined;
    setTestWorker(async (args): Promise<AgentWorkerResult> => {
      ({ onComplete } = args);
      return { ok: true, chatId: "chat-2" };
    });

    await refreshViaAgent(root, collection);
    assert.ok(onComplete, "runner received an onComplete hook");

    // Worker failed.
    await onComplete?.({ didError: true });
    let state = await readFeedState(root, collection);
    assert.equal(state.consecutiveFailures, 1);
    assert.ok(state.failureBellId, "a failure bell id is persisted");

    // A second failure doesn't pile up a second bell.
    const firstBell = state.failureBellId;
    await onComplete?.({ didError: true });
    state = await readFeedState(root, collection);
    assert.equal(state.consecutiveFailures, 2);
    assert.equal(state.failureBellId, firstBell, "same bell, deduped");

    // Worker succeeded → counter resets and the bell clears.
    await onComplete?.({ didError: false });
    state = await readFeedState(root, collection);
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.failureBellId, undefined, "bell cleared on success");
  });
});
