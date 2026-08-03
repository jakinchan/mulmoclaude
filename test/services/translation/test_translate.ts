import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { WORKSPACE_DIRS } from "../../../server/workspace/paths.js";
import { createTranslationService, TranslationInputError } from "../../../server/services/translation/index.js";
import type { TranslateBatchFn, TranslateBatchInput } from "../../../server/services/translation/types.js";

interface MockBackend {
  readonly fn: TranslateBatchFn;
  readonly calls: TranslateBatchInput[];
}

function makeMock(fakeTranslate: (sentence: string, lang: string) => string = (sentence, lang) => `[${lang}]${sentence}`): MockBackend {
  const calls: TranslateBatchInput[] = [];
  const runner: TranslateBatchFn = async (input) => {
    calls.push({ targetLanguage: input.targetLanguage, sentences: [...input.sentences] });
    return input.sentences.map((sentence) => fakeTranslate(sentence, input.targetLanguage));
  };
  return { fn: runner, calls };
}

function dictPath(root: string, namespace: string): string {
  return path.join(root, WORKSPACE_DIRS.translation, `${namespace}.json`);
}

function readDict(root: string, namespace: string): unknown {
  return JSON.parse(readFileSync(dictPath(root, namespace), "utf-8"));
}

describe("translation service — cold/warm/partial", () => {
  let root: string;
  before(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "mulmoclaude-tr-")));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("cold: missing cache → mock called with all sentences, file written, result matches", async () => {
    const mock = makeMock();
    const service = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    const { translations } = await service.translate({
      namespace: "cold",
      targetLanguage: "ja",
      sentences: ["Hello", "World"],
    });
    assert.deepEqual(translations, ["[ja]Hello", "[ja]World"]);
    assert.equal(mock.calls.length, 1);
    const [batch] = mock.calls;
    assert.ok(batch);
    assert.deepEqual([...batch.sentences].sort(), ["Hello", "World"]);
    assert.deepEqual(readDict(root, "cold"), {
      sentences: {
        Hello: { ja: "[ja]Hello" },
        World: { ja: "[ja]World" },
      },
    });
  });

  it("warm: full cache hit → mock NOT called", async () => {
    const mock = makeMock();
    const service = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    // primed by the previous test
    const { translations } = await service.translate({
      namespace: "cold",
      targetLanguage: "ja",
      sentences: ["World", "Hello"],
    });
    assert.deepEqual(translations, ["[ja]World", "[ja]Hello"]);
    assert.equal(mock.calls.length, 0);
  });

  it("partial: some cached, some missing → mock called only with misses, result preserves input order", async () => {
    const mock = makeMock();
    const service = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    const { translations } = await service.translate({
      namespace: "cold",
      targetLanguage: "ja",
      sentences: ["Hello", "Foo", "World", "Bar"],
    });
    assert.deepEqual(translations, ["[ja]Hello", "[ja]Foo", "[ja]World", "[ja]Bar"]);
    assert.equal(mock.calls.length, 1);
    const [batch] = mock.calls;
    assert.ok(batch);
    assert.deepEqual([...batch.sentences].sort(), ["Bar", "Foo"]);
  });

  it("merge: adding a new language preserves existing one", async () => {
    const mock = makeMock();
    const service = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    await service.translate({
      namespace: "cold",
      targetLanguage: "ko",
      sentences: ["Hello"],
    });
    const dict = readDict(root, "cold") as { sentences: Record<string, Record<string, string>> };
    assert.deepEqual(dict.sentences.Hello, { ja: "[ja]Hello", ko: "[ko]Hello" });
  });
});

describe("translation service — en short-circuit", () => {
  let root: string;
  before(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "mulmoclaude-tr-en-")));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("targetLanguage en → mock NOT called, no cache file, returns input verbatim", async () => {
    const mock = makeMock();
    const service = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    const { translations } = await service.translate({
      namespace: "en-test",
      targetLanguage: "en",
      sentences: ["Hello", "World"],
    });
    assert.deepEqual(translations, ["Hello", "World"]);
    assert.equal(mock.calls.length, 0);
    assert.equal(existsSync(dictPath(root, "en-test")), false);
  });
});

describe("translation service — validation", () => {
  let root: string;
  let service: ReturnType<typeof createTranslationService>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "mulmoclaude-tr-val-")));
    service = createTranslationService({ translateBatch: makeMock().fn, workspaceRoot: root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("rejects path-traversal namespace", async () => {
    await assert.rejects(() => service.translate({ namespace: "../etc", targetLanguage: "ja", sentences: ["Hi"] }), TranslationInputError);
  });

  it("rejects empty namespace", async () => {
    await assert.rejects(() => service.translate({ namespace: "", targetLanguage: "ja", sentences: ["Hi"] }), TranslationInputError);
  });

  it("rejects malformed targetLanguage", async () => {
    await assert.rejects(() => service.translate({ namespace: "ns", targetLanguage: "Japanese", sentences: ["Hi"] }), TranslationInputError);
  });

  it("accepts BCP-47 region code (pt-BR)", async () => {
    const mock = makeMock();
    const svc = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    const { translations } = await svc.translate({ namespace: "ns", targetLanguage: "pt-BR", sentences: ["Hi"] });
    assert.deepEqual(translations, ["[pt-BR]Hi"]);
  });

  it("rejects empty sentences array", async () => {
    await assert.rejects(() => service.translate({ namespace: "ns", targetLanguage: "ja", sentences: [] }), TranslationInputError);
  });

  it("rejects sentences with empty strings", async () => {
    await assert.rejects(() => service.translate({ namespace: "ns", targetLanguage: "ja", sentences: ["Hi", ""] }), TranslationInputError);
  });
});

describe("translation service — backend contract", () => {
  let root: string;
  before(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "mulmoclaude-tr-bad-")));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("throws when translateBatch returns the wrong number of strings", async () => {
    const wrongLength: TranslateBatchFn = async () => ["only-one"];
    const service = createTranslationService({ translateBatch: wrongLength, workspaceRoot: root });
    await assert.rejects(() => service.translate({ namespace: "ns", targetLanguage: "ja", sentences: ["A", "B"] }), /returned 1 translations for 2 sentences/);
  });
});

describe("translation service — request bounds", () => {
  let root: string;
  let service: ReturnType<typeof createTranslationService>;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "mulmoclaude-tr-bnd-")));
    service = createTranslationService({ translateBatch: makeMock().fn, workspaceRoot: root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("rejects more than 256 sentences", async () => {
    const tooMany = Array.from({ length: 257 }, (_value, index) => `s${index}`);
    await assert.rejects(() => service.translate({ namespace: "ns", targetLanguage: "ja", sentences: tooMany }), TranslationInputError);
  });

  it("rejects a single sentence longer than 1024 chars", async () => {
    const long = "x".repeat(1025);
    await assert.rejects(() => service.translate({ namespace: "ns", targetLanguage: "ja", sentences: [long] }), TranslationInputError);
  });

  it("rejects total payload over 32KiB", async () => {
    // 64 sentences × 1024 chars = 65536 chars, well over the 32KiB total cap.
    const sentence = "x".repeat(1024);
    const tooBig = Array.from({ length: 64 }, () => sentence);
    await assert.rejects(() => service.translate({ namespace: "ns", targetLanguage: "ja", sentences: tooBig }), TranslationInputError);
  });
});

describe("translation service — cache shape robustness", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "mulmoclaude-tr-shape-")));
    mkdirSync(path.join(root, WORKSPACE_DIRS.translation), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeRawDict(namespace: string, raw: string): void {
    writeFileSync(dictPath(root, namespace), raw, "utf-8");
  }

  it("malformed JSON: parse fails → falls back to empty dict, fresh translation written", async () => {
    writeRawDict("ns", "{ this is not json");
    const mock = makeMock();
    const service = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    const { translations } = await service.translate({ namespace: "ns", targetLanguage: "ja", sentences: ["Hello"] });
    assert.deepEqual(translations, ["[ja]Hello"]);
    assert.equal(mock.calls.length, 1);
  });

  it("wrong shape (sentences: null): treated as empty cache, no crash", async () => {
    writeRawDict("ns", JSON.stringify({ sentences: null }));
    const mock = makeMock();
    const service = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    const { translations } = await service.translate({ namespace: "ns", targetLanguage: "ja", sentences: ["Hello"] });
    assert.deepEqual(translations, ["[ja]Hello"]);
  });

  it("wrong shape (top-level array): treated as empty cache, no crash", async () => {
    writeRawDict("ns", JSON.stringify([]));
    const mock = makeMock();
    const service = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    const { translations } = await service.translate({ namespace: "ns", targetLanguage: "ja", sentences: ["Hello"] });
    assert.deepEqual(translations, ["[ja]Hello"]);
  });

  it("wrong shape (translation value not a string): treated as empty cache, fresh write replaces it", async () => {
    writeRawDict("ns", JSON.stringify({ sentences: { Hello: { ja: 42 } } }));
    const mock = makeMock();
    const service = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    const { translations } = await service.translate({ namespace: "ns", targetLanguage: "ja", sentences: ["Hello"] });
    assert.deepEqual(translations, ["[ja]Hello"]);
    assert.deepEqual(readDict(root, "ns"), { sentences: { Hello: { ja: "[ja]Hello" } } });
  });
});

describe("translation service — prototype-key safety", () => {
  let root: string;
  before(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "mulmoclaude-tr-proto-")));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("a sentence whose value is `__proto__` is stored, retrieved, and never pollutes Object.prototype", async () => {
    const mock = makeMock();
    const service = createTranslationService({ translateBatch: mock.fn, workspaceRoot: root });
    await service.translate({ namespace: "ns", targetLanguage: "ja", sentences: ["__proto__"] });
    // Sanity: nothing leaked onto Object.prototype.
    assert.equal(({} as Record<string, unknown>).ja, undefined);

    // Round-trip through the cache: second call should hit the persisted entry.
    const { translations } = await service.translate({ namespace: "ns", targetLanguage: "ja", sentences: ["__proto__"] });
    assert.deepEqual(translations, ["[ja]__proto__"]);
    assert.equal(mock.calls.length, 1);

    const onDisk = readDict(root, "ns") as { sentences: Record<string, Record<string, string>> };
    // eslint-disable-next-line no-proto -- the whole point of this test is to verify a literal "__proto__" sentence round-trips as an own property.
    assert.equal(onDisk.sentences["__proto__"]?.ja, "[ja]__proto__");
  });
});

describe("translation service — single-flight serialization", () => {
  let root: string;
  before(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "mulmoclaude-tr-sf-")));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("two concurrent calls on the same namespace serialize: the second sees the first's writes", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const calls: TranslateBatchInput[] = [];
    let callIndex = 0;
    const gated: TranslateBatchFn = async (input) => {
      calls.push({ targetLanguage: input.targetLanguage, sentences: [...input.sentences] });
      callIndex += 1;
      if (callIndex === 1) {
        await firstGate;
      }
      return input.sentences.map((sentence) => `[${input.targetLanguage}]${sentence}`);
    };

    const service = createTranslationService({ translateBatch: gated, workspaceRoot: root });

    const firstCall = service.translate({ namespace: "ns", targetLanguage: "ja", sentences: ["Hello"] });
    const secondCall = service.translate({ namespace: "ns", targetLanguage: "ja", sentences: ["Hello", "World"] });

    // Yield so the second call can register its serialization continuation behind the first.
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst?.();

    const [resA, resB] = await Promise.all([firstCall, secondCall]);
    assert.deepEqual(resA.translations, ["[ja]Hello"]);
    assert.deepEqual(resB.translations, ["[ja]Hello", "[ja]World"]);

    // First mock invocation handled "Hello"; second should have been called only with "World".
    assert.equal(calls.length, 2);
    const [firstBatch, secondBatch] = calls;
    assert.ok(firstBatch);
    assert.ok(secondBatch);
    assert.deepEqual([...firstBatch.sentences], ["Hello"]);
    assert.deepEqual([...secondBatch.sentences], ["World"]);
  });
});
