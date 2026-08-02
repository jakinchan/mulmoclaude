import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useFileContentLoader } from "../../src/composables/useFileContentLoader.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function textPayload(path: string, content: string) {
  return { kind: "text" as const, path, content, size: content.length, modifiedMs: 0 };
}

interface PendingCall {
  signal: AbortSignal | null | undefined;
  resolve: (res: Response) => void;
}

// A fetch whose responses stay pending until the test resolves them by
// hand — lets us interleave two loads and inspect the state in between.
function installControllableFetch(): PendingCall[] {
  const calls: PendingCall[] = [];
  const impl: typeof fetch = (_input, init) => {
    const signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      calls.push({ signal, resolve });
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  };
  globalThis.fetch = impl;
  return calls;
}

describe("useFileContentLoader", () => {
  it("loads text content on success", async () => {
    globalThis.fetch = async () => jsonResponse(200, textPayload("a.txt", "hello"));
    const { content, contentLoading, contentError, loadContent } = useFileContentLoader();
    await loadContent("a.txt");
    assert.deepEqual(content.value, textPayload("a.txt", "hello"));
    assert.equal(contentLoading.value, false);
    assert.equal(contentError.value, null);
  });

  it("surfaces the server error on an HTTP failure", async () => {
    globalThis.fetch = async () => jsonResponse(500, { error: "boom" });
    const { content, contentLoading, contentError, loadContent } = useFileContentLoader();
    await loadContent("a.txt");
    assert.equal(content.value, null);
    assert.equal(contentError.value, "boom");
    assert.equal(contentLoading.value, false);
  });

  it("a stale load resolving late does not clear the newer load's state", async () => {
    const calls = installControllableFetch();
    const loader = useFileContentLoader();
    const stale = loader.loadContent("a.txt");
    const fresh = loader.loadContent("b.txt");
    await stale;
    assert.equal(loader.contentLoading.value, true);
    assert.equal(loader.content.value, null);
    assert.equal(loader.contentError.value, null);
    const [, freshCall] = calls;
    assert.ok(freshCall);
    freshCall.resolve(jsonResponse(200, textPayload("b.txt", "fresh")));
    await fresh;
    assert.deepEqual(loader.content.value, textPayload("b.txt", "fresh"));
    assert.equal(loader.contentLoading.value, false);
    assert.equal(loader.contentError.value, null);
  });

  // The reason `selectFile` can call this fire-and-forget: a network-level
  // failure resolves into `contentError` instead of rejecting. `apiCall`
  // catches the `fetch` throw and returns `{ ok: false, status: 0 }`, so
  // nothing escapes for a caller to have to `.catch`. Pinning that here — if
  // the api layer ever starts rethrowing, the detached callers become
  // unhandled-rejection sites and this test is what catches it.
  it("a network-level fetch throw resolves into contentError, it does not reject", async () => {
    globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    const { content, contentLoading, contentError, loadContent } = useFileContentLoader();
    await assert.doesNotReject(loadContent("a.txt"));
    assert.equal(content.value, null);
    assert.match(contentError.value ?? "", /Failed to fetch/);
    assert.equal(contentLoading.value, false);
  });

  it("abortContent stops the in-flight load and clears loading", async () => {
    installControllableFetch();
    const loader = useFileContentLoader();
    const pending = loader.loadContent("a.txt");
    loader.abortContent();
    assert.equal(loader.contentLoading.value, false);
    await pending;
    assert.equal(loader.content.value, null);
    assert.equal(loader.contentLoading.value, false);
  });
});
