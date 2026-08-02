// Unit tests for the startChat remote-host handler.
//
// Two forms (see the handler header): the CURRENT free-text form (`{ message }`
// only, seeded verbatim) and the LEGACY `slug` form (`/<slug> [id=<itemId>]
// <message>` composition, feed refusal, token validation). The host spawner +
// collection engine are stubbed so the test asserts what message is spawned —
// not that a real chat subprocess launches.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { composeMessage, createStartChat, type StartChatDeps } from "../../server/remoteHost/handlers/startChat.js";

type SpawnArgs = Parameters<StartChatDeps["spawn"]>[0];
type Loaded = Awaited<ReturnType<StartChatDeps["loadCollection"]>>;

const collection = { source: "user" } as unknown as Loaded;
const feed = { source: "feed" } as unknown as Loaded;

// Stub role registry — `general` (the default), one custom role, and a
// debug-only role, enough to exercise "known role passes / unknown role rejects
// / debug role rejected" branches.
const roles = [{ id: "general" }, { id: "accounting" }, { id: "debug", isDebugRole: true }] as unknown as ReturnType<StartChatDeps["loadRoles"]>;

// Build stub deps. `loadResult` is what `loadCollection` resolves to (only the
// legacy slug path calls it): a normal collection (default) ⇒ chat proceeds;
// `feed` ⇒ refused; `null` ⇒ unknown slug, rejected. `ingestOverride` swaps the
// default image-ingest stub (which echoes one attachment per storage_id) — used
// to simulate an ingest failure. `calls` captures the spawn arguments;
// `loadCalls` records whether the collection engine was consulted;
// `ingestCalls` records each storage_id list handed to ingest.
const makeDeps = (result: Awaited<ReturnType<StartChatDeps["spawn"]>>, loadResult: Loaded = collection, ingestOverride?: StartChatDeps["ingest"]) => {
  const calls: SpawnArgs[] = [];
  const loadCalls: string[] = [];
  const ingestCalls: string[][] = [];
  const spawn = (async (args: SpawnArgs) => {
    calls.push(args);
    return result;
  }) as StartChatDeps["spawn"];
  const loadCollection = (async (slug: string) => {
    loadCalls.push(slug);
    return loadResult;
  }) as StartChatDeps["loadCollection"];
  const ingest =
    ingestOverride ??
    ((async (storageIds: string[]) => {
      ingestCalls.push(storageIds);
      return storageIds.map((storageId) => ({ path: `data/attachments/${storageId}.jpg`, mimeType: "image/jpeg" }));
    }) as StartChatDeps["ingest"]);
  const loadRoles = (() => roles) as StartChatDeps["loadRoles"];
  return { deps: { spawn, loadCollection, ingest, loadRoles } as StartChatDeps, calls, loadCalls, ingestCalls };
};

// ── CURRENT form: `{ message }` only, seeded verbatim ──────────────────────
describe("createStartChat — free-text form (current clients)", () => {
  it("spawns a visible chat with the message verbatim and returns the chatId", async () => {
    const { deps, calls, loadCalls } = makeDeps({ ok: true, chatId: "chat-1" });
    const result = await createStartChat(deps)({ message: "who is overdue?" });
    assert.deepEqual(result, { started: true, chatId: "chat-1" });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.message, "who is overdue?");
    assert.equal(call.hidden, false);
    // The collection engine is NOT consulted when no slug is sent.
    assert.equal(loadCalls.length, 0);
  });

  it("trims surrounding whitespace from the message", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-2" });
    await createStartChat(deps)({ message: "  hello  " });
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.message, "hello");
  });

  it("passes a slash-command message through untouched (the host does not interpret it)", async () => {
    const { deps, calls, loadCalls } = makeDeps({ ok: true, chatId: "chat-3" });
    await createStartChat(deps)({ message: "/clients id=acme draft a follow-up" });
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.message, "/clients id=acme draft a follow-up");
    assert.equal(loadCalls.length, 0);
  });

  it("treats a null or empty-string slug as absent (free-text, no collection load)", async () => {
    const { deps, calls, loadCalls } = makeDeps({ ok: true, chatId: "chat-4" });
    await createStartChat(deps)({ message: "hi", slug: "" });
    await createStartChat(deps)({ message: "hi", slug: null });
    assert.deepEqual(
      calls.map((call) => call.message),
      ["hi", "hi"],
    );
    assert.equal(loadCalls.length, 0);
  });

  it("throws when message is blank, without spawning", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-5" });
    await assert.rejects(async () => createStartChat(deps)({ message: "   " }), /message is required/);
    assert.equal(calls.length, 0);
  });

  it("throws when message is missing or non-string", async () => {
    const { deps } = makeDeps({ ok: true, chatId: "chat-6" });
    await assert.rejects(async () => createStartChat(deps)({}), /message is required/);
    await assert.rejects(async () => createStartChat(deps)({ message: 123 }), /message is required/);
  });

  it("surfaces a spawn failure as a thrown error", async () => {
    const { deps } = makeDeps({ ok: false, error: "too many background sessions" });
    await assert.rejects(async () => createStartChat(deps)({ message: "hi" }), /too many background sessions/);
  });
});

// ── LEGACY form: `{ slug, itemId?, message }` → composed slash command ──────
describe("composeMessage (legacy)", () => {
  it("prefixes the collection slash command for a whole-collection chat", () => {
    assert.equal(composeMessage("clients", "", "who is overdue?"), "/clients who is overdue?");
  });

  it("scopes to a record with id= when an itemId is given", () => {
    assert.equal(composeMessage("clients", "acme", "draft a follow-up"), "/clients id=acme draft a follow-up");
  });
});

describe("createStartChat — legacy slug form", () => {
  it("composes the /<slug> id= seed from a legacy client and returns the chatId", async () => {
    const { deps, calls, loadCalls } = makeDeps({ ok: true, chatId: "chat-1" });
    const result = await createStartChat(deps)({ slug: "clients", itemId: "acme", message: "  hello  " });
    assert.deepEqual(result, { started: true, chatId: "chat-1" });
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.message, "/clients id=acme hello");
    assert.deepEqual(loadCalls, ["clients"]);
  });

  it("omits id= when itemId is absent", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-2" });
    await createStartChat(deps)({ slug: "clients", message: "hi" });
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.message, "/clients hi");
  });

  it("refuses feeds (no /<slug> command) without spawning", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-feed" }, feed);
    await assert.rejects(async () => createStartChat(deps)({ slug: "news", message: "summarize" }), /not available for feeds/);
    assert.equal(calls.length, 0);
  });

  it("rejects an unknown slug (loadCollection returns null) without spawning", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-missing" }, null);
    await assert.rejects(async () => createStartChat(deps)({ slug: "ghost", message: "hi" }), /collection 'ghost' not found/);
    assert.equal(calls.length, 0);
  });

  it("rejects a whitespace-containing or non-string slug (malformed prefix)", async () => {
    const { deps } = makeDeps({ ok: true, chatId: "chat-3" });
    await assert.rejects(async () => createStartChat(deps)({ slug: "a b", message: "hi" }), /slug must be a non-empty/);
    await assert.rejects(async () => createStartChat(deps)({ slug: 123, message: "hi" }), /slug must be a non-empty/);
  });

  it("rejects an itemId that is present but whitespace-containing", async () => {
    const { deps } = makeDeps({ ok: true, chatId: "chat-4" });
    await assert.rejects(async () => createStartChat(deps)({ slug: "clients", itemId: "a b", message: "hi" }), /itemId must be a non-empty/);
  });
});

// ── File attachments: { message, attachments:[{ storage_id }] } ────────────
describe("createStartChat — file attachments", () => {
  it("ingests staged files and hands the resulting attachments to spawn", async () => {
    const { deps, calls, ingestCalls } = makeDeps({ ok: true, chatId: "chat-1" });
    const result = await createStartChat(deps)({ message: "look at these", attachments: [{ storage_id: "aaa" }, { storage_id: "bbb" }] });
    assert.deepEqual(result, { started: true, chatId: "chat-1" });
    assert.deepEqual(ingestCalls, [["aaa", "bbb"]]);
    const [call] = calls;
    assert.ok(call);
    assert.deepEqual(call.attachments, [
      { path: "data/attachments/aaa.jpg", mimeType: "image/jpeg" },
      { path: "data/attachments/bbb.jpg", mimeType: "image/jpeg" },
    ]);
    assert.equal(call.message, "look at these");
  });

  it("passes an empty attachment list when none are sent (text-only parity)", async () => {
    const { deps, calls, ingestCalls } = makeDeps({ ok: true, chatId: "chat-2" });
    await createStartChat(deps)({ message: "hi" });
    assert.deepEqual(ingestCalls, [[]]);
    const [call] = calls;
    assert.ok(call);
    assert.deepEqual(call.attachments, []);
  });

  it("rejects a malformed attachments payload without spawning", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-3" });
    await assert.rejects(async () => createStartChat(deps)({ message: "hi", attachments: "nope" }), /attachments must be an array/);
    await assert.rejects(async () => createStartChat(deps)({ message: "hi", attachments: [{}] }), /each attachments entry/);
    assert.equal(calls.length, 0);
  });

  it("surfaces an ingest failure without spawning", async () => {
    const failing = (async () => {
      throw new Error("storage 404");
    }) as StartChatDeps["ingest"];
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-4" }, collection, failing);
    await assert.rejects(async () => createStartChat(deps)({ message: "hi", attachments: [{ storage_id: "aaa" }] }), /storage 404/);
    assert.equal(calls.length, 0);
  });
});

// ── Role selection: { message, role } ──────────────────────────────────────
describe("createStartChat — role selection", () => {
  it("defaults to the general role when no role is sent", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-1" });
    await createStartChat(deps)({ message: "hi" });
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.roleId, "general");
  });

  it("treats null / empty-string role as absent (default role)", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-2" });
    await createStartChat(deps)({ message: "hi", role: "" });
    await createStartChat(deps)({ message: "hi", role: null });
    assert.deepEqual(
      calls.map((call) => call.roleId),
      ["general", "general"],
    );
  });

  it("runs the chat in a known role when one is sent", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-3" });
    await createStartChat(deps)({ message: "record today's receipt", role: "accounting" });
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.roleId, "accounting");
  });

  it("rejects an unknown role without spawning", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-4" });
    await assert.rejects(async () => createStartChat(deps)({ message: "hi", role: "ghost" }), /role 'ghost' not found/);
    assert.equal(calls.length, 0);
  });

  it("rejects a debug-only role (not selectable from the production remote channel)", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-debug" });
    await assert.rejects(async () => createStartChat(deps)({ message: "hi", role: "debug" }), /role 'debug' not found/);
    assert.equal(calls.length, 0);
  });

  it("rejects a non-string role without spawning", async () => {
    const { deps, calls } = makeDeps({ ok: true, chatId: "chat-5" });
    await assert.rejects(async () => createStartChat(deps)({ message: "hi", role: 7 }), /role must be a string/);
    assert.equal(calls.length, 0);
  });
});
