import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { nextTick, ref } from "vue";
import { __resetTranslatedQueriesCacheForTests, useTranslatedQueries } from "../../src/composables/useTranslatedQueries.js";
import type { Role } from "../../src/config/roles.js";

interface FetchCall {
  readonly url: string;
  readonly body: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalFetch: any = (globalThis as any).fetch;

let fetchCalls: FetchCall[] = [];
async function defaultResponder(__call: FetchCall): Promise<Response> {
  return mockJson(200, { translations: [] });
}
let fetchResponder: (call: FetchCall) => Promise<Response> = defaultResponder;

function mockJson(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function installFetchStub(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (input: unknown, init?: any) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    const call: FetchCall = { url, body };
    fetchCalls.push(call);
    return fetchResponder(call);
  };
}

function makeRole(roleId: string, queries: string[] | undefined): Role {
  return {
    id: roleId,
    name: roleId,
    icon: "",
    prompt: "",
    availablePlugins: [],
    queries,
  } as unknown as Role;
}

// Wait until the inflight fetch (if any) has settled and Vue has
// flushed the resulting reactive updates.
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

describe("useTranslatedQueries", () => {
  beforeEach(() => {
    fetchCalls = [];
    fetchResponder = async () => mockJson(200, { translations: [] });
    __resetTranslatedQueriesCacheForTests();
    installFetchStub();
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = originalFetch;
  });

  it("en short-circuit: returns source verbatim, no fetch", async () => {
    const role = ref<Role | undefined>(makeRole("general", ["Hello", "World"]));
    const locale = ref("en");
    const { queries } = useTranslatedQueries(role, locale);
    await settle();
    assert.deepEqual(queries.value, ["Hello", "World"]);
    assert.equal(fetchCalls.length, 0);
  });

  it("non-en: falls back to source until response lands, then swaps", async () => {
    fetchResponder = async () => mockJson(200, { translations: ["こんにちは", "世界"] });
    const role = ref<Role | undefined>(makeRole("general", ["Hello", "World"]));
    const locale = ref("ja");
    const { queries } = useTranslatedQueries(role, locale);
    // initial value before fetch resolves: source
    assert.deepEqual(queries.value, ["Hello", "World"]);
    await settle();
    assert.deepEqual(queries.value, ["こんにちは", "世界"]);
    assert.equal(fetchCalls.length, 1);
    const [firstCall] = fetchCalls;
    assert.ok(firstCall);
    assert.equal(firstCall.url, "/api/translation");
    assert.deepEqual(firstCall.body, {
      namespace: "role-queries",
      targetLanguage: "ja",
      sentences: ["Hello", "World"],
    });
  });

  it("dedup: two composable instances on the same role+locale share one fetch", async () => {
    fetchResponder = async () => mockJson(200, { translations: ["こんにちは"] });
    const roleA = ref<Role | undefined>(makeRole("general", ["Hello"]));
    const roleB = ref<Role | undefined>(makeRole("general", ["Hello"]));
    const locale = ref("ja");
    const { queries: queriesA } = useTranslatedQueries(roleA, locale);
    const { queries: queriesB } = useTranslatedQueries(roleB, locale);
    await settle();
    assert.deepEqual(queriesA.value, ["こんにちは"]);
    assert.deepEqual(queriesB.value, ["こんにちは"]);
    assert.equal(fetchCalls.length, 1);
  });

  it("locale change: re-fetches in the new locale, leaves source as fallback meanwhile", async () => {
    fetchResponder = async (call) => {
      const lang = (call.body as { targetLanguage: string }).targetLanguage;
      const map: Record<string, string[]> = { ja: ["こんにちは"], ko: ["안녕하세요"] };
      return mockJson(200, { translations: map[lang] ?? [] });
    };
    const role = ref<Role | undefined>(makeRole("general", ["Hello"]));
    const locale = ref("ja");
    const { queries } = useTranslatedQueries(role, locale);
    await settle();
    assert.deepEqual(queries.value, ["こんにちは"]);
    locale.value = "ko";
    // English fallback while the second fetch is in flight
    await Promise.resolve();
    await nextTick();
    assert.deepEqual(queries.value, ["Hello"]);
    await settle();
    assert.deepEqual(queries.value, ["안녕하세요"]);
    assert.equal(fetchCalls.length, 2);
  });

  it("fetch error: keeps source fallback, no throw", async () => {
    fetchResponder = async () => mockJson(500, { error: "boom" });
    const role = ref<Role | undefined>(makeRole("general", ["Hello"]));
    const locale = ref("ja");
    const { queries } = useTranslatedQueries(role, locale);
    await settle();
    assert.deepEqual(queries.value, ["Hello"]);
    assert.equal(fetchCalls.length, 1);
  });

  it("length mismatch from server: keeps source fallback", async () => {
    fetchResponder = async () => mockJson(200, { translations: ["only-one"] });
    const role = ref<Role | undefined>(makeRole("general", ["Hello", "World"]));
    const locale = ref("ja");
    const { queries } = useTranslatedQueries(role, locale);
    await settle();
    assert.deepEqual(queries.value, ["Hello", "World"]);
  });

  it("role with no queries: returns empty array, no fetch", async () => {
    const role = ref<Role | undefined>(makeRole("empty", undefined));
    const locale = ref("ja");
    const { queries } = useTranslatedQueries(role, locale);
    await settle();
    assert.deepEqual(queries.value, []);
    assert.equal(fetchCalls.length, 0);
  });
});
