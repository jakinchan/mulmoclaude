// Unit test for `useOpenInOs` composable that backs the "Open in OS"
// button on FileContentRenderer's binary-file fallback (#1985).
// Codex iter-4 asked for coverage of the busy/error state transitions
// and the auto-reset behaviour when `selectedPath` changes — the
// composable exists so those transitions can be tested without
// mounting the full component.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { nextTick, ref } from "vue";
import { useOpenInOs, useRevealInOs } from "../../src/composables/useOpenInOs.ts";

interface FetchStubResponse {
  status: number;
  jsonBody: unknown;
}

let fetchCalls: { url: string; init?: { method?: string | undefined; body?: string | undefined } | undefined }[] = [];
let nextResponse: FetchStubResponse = { status: 200, jsonBody: { ok: true } };
let shouldThrow: Error | null = null;

const originalFetch = globalThis.fetch;

function installFetchStub(): void {
  fetchCalls = [];
  nextResponse = { status: 200, jsonBody: { ok: true } };
  shouldThrow = null;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    fetchCalls.push({ url: String(input), init: init as { method?: string; body?: string } | undefined });
    if (shouldThrow) throw shouldThrow;
    const { status, jsonBody } = nextResponse;
    const makeResponse = (): Response =>
      ({
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        json: async () => jsonBody,
        text: async () => JSON.stringify(jsonBody),
        clone: () => makeResponse(),
      }) as unknown as Response;
    return makeResponse();
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

describe("useOpenInOs", () => {
  beforeEach(installFetchStub);
  afterEach(restoreFetch);

  it("starts idle: busy=false, error=null", () => {
    const path = ref<string | null>("dir/file.pptx");
    const { busy, error } = useOpenInOs(path, () => "fallback");
    assert.equal(busy.value, false);
    assert.equal(error.value, null);
  });

  it("does nothing when selectedPath is null", async () => {
    const path = ref<string | null>(null);
    const { busy, error, open } = useOpenInOs(path, () => "fallback");
    await open();
    assert.equal(busy.value, false);
    assert.equal(error.value, null);
    assert.equal(fetchCalls.length, 0);
  });

  it("posts to /api/files/open with the path in both query and body", async () => {
    const path = ref<string | null>("docs/report.pptx");
    const { open } = useOpenInOs(path, () => "fallback");
    await open();
    assert.equal(fetchCalls.length, 1);
    const [call] = fetchCalls;
    assert.ok(call);
    assert.match(call.url, /\/api\/files\/open\?path=docs%2Freport\.pptx$/);
    assert.equal(call.init?.method, "POST");
    const parsed = JSON.parse(call.init?.body ?? "{}") as { path?: string };
    assert.equal(parsed.path, "docs/report.pptx");
  });

  it("clears error on successful open and leaves busy=false when settled", async () => {
    const path = ref<string | null>("a.pptx");
    const { busy, error, open } = useOpenInOs(path, () => "fallback");
    await open();
    assert.equal(busy.value, false);
    assert.equal(error.value, null);
  });

  it("surfaces server error message when the response says ok:false", async () => {
    nextResponse = { status: 500, jsonBody: { error: "Failed to launch OS file handler" } };
    const path = ref<string | null>("a.pptx");
    const { busy, error, open } = useOpenInOs(path, () => "fallback message");
    await open();
    assert.equal(busy.value, false);
    assert.equal(error.value, "Failed to launch OS file handler");
  });

  it("resets busy and error when selectedPath changes to a different file", async () => {
    nextResponse = { status: 500, jsonBody: { error: "boom" } };
    const path = ref<string | null>("a.pptx");
    const { busy, error, open } = useOpenInOs(path, () => "fallback");
    await open();
    assert.equal(error.value, "boom");

    // Simulate user navigating to a different file — error and busy
    // must reset so file B's UI doesn't inherit file A's error banner.
    path.value = "b.pptx";
    await nextTick();
    assert.equal(busy.value, false);
    assert.equal(error.value, null);
  });

  it("resets state on selectedPath -> null too (deselection)", async () => {
    nextResponse = { status: 500, jsonBody: { error: "boom" } };
    const path = ref<string | null>("a.pptx");
    const { busy, error, open } = useOpenInOs(path, () => "fallback");
    await open();
    assert.equal(error.value, "boom");
    path.value = null;
    await nextTick();
    assert.equal(busy.value, false);
    assert.equal(error.value, null);
  });

  it("re-arms after an error: a second open clears the error before making the request", async () => {
    nextResponse = { status: 500, jsonBody: { error: "boom" } };
    const path = ref<string | null>("a.pptx");
    const { error, open } = useOpenInOs(path, () => "fallback");
    await open();
    assert.equal(error.value, "boom");

    nextResponse = { status: 200, jsonBody: { ok: true } };
    await open();
    assert.equal(error.value, null);
  });
});

describe("useRevealInOs", () => {
  beforeEach(installFetchStub);
  afterEach(restoreFetch);

  it("posts to /api/files/reveal with the path in both query and body", async () => {
    const path = ref<string | null>("docs/report.xlsx");
    const { reveal } = useRevealInOs(path, () => "fallback");
    await reveal();
    assert.equal(fetchCalls.length, 1);
    const [call] = fetchCalls;
    assert.ok(call);
    assert.match(call.url, /\/api\/files\/reveal\?path=docs%2Freport\.xlsx$/);
    assert.equal(call.init?.method, "POST");
    const parsed = JSON.parse(call.init?.body ?? "{}") as { path?: string };
    assert.equal(parsed.path, "docs/report.xlsx");
  });

  it("does nothing when selectedPath is null", async () => {
    const path = ref<string | null>(null);
    const { busy, error, reveal } = useRevealInOs(path, () => "fallback");
    await reveal();
    assert.equal(busy.value, false);
    assert.equal(error.value, null);
    assert.equal(fetchCalls.length, 0);
  });

  it("surfaces server error message when the response says ok:false", async () => {
    nextResponse = { status: 500, jsonBody: { error: "Failed to reveal file in OS file manager" } };
    const path = ref<string | null>("a.xlsx");
    const { error, reveal } = useRevealInOs(path, () => "fallback message");
    await reveal();
    assert.equal(error.value, "Failed to reveal file in OS file manager");
  });

  it("resets error when selectedPath changes to a different file", async () => {
    nextResponse = { status: 500, jsonBody: { error: "boom" } };
    const path = ref<string | null>("a.xlsx");
    const { error, reveal } = useRevealInOs(path, () => "fallback");
    await reveal();
    assert.equal(error.value, "boom");
    path.value = "b.xlsx";
    await nextTick();
    assert.equal(error.value, null);
  });
});
