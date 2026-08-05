// Per-session composer drafts (#2811). The rules that matter here are
// the ones the pure store can't express: which session a read/write
// lands in, that attachments never reach storage, and that the drop
// path — the one every session eviction and delete broadcast calls —
// clears both halves without rewriting storage when there was nothing
// to clear.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { nextTick, ref } from "vue";
import { useChatDrafts } from "../../src/composables/useChatDrafts.ts";
import { CHAT_DRAFTS_STORAGE_KEY, parseStoredDrafts } from "../../src/utils/chat/draftStore.ts";
import type { PastedFile } from "../../src/types/pastedFile.ts";

const storage = new Map<string, string>();
let writes = 0;

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

function installStubStorage(): void {
  storage.clear();
  writes = 0;
  Object.defineProperty(globalThis, "sessionStorage", {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
    },
    writable: true,
    configurable: true,
  });
}

function restoreStorage(): void {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, "sessionStorage", originalDescriptor);
  } else {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
}

function storedDrafts(): Record<string, string> {
  return parseStoredDrafts(storage.get(CHAT_DRAFTS_STORAGE_KEY) ?? null);
}

function makeFile(name: string): PastedFile {
  return { dataUrl: `data:image/png;base64,${name}`, name, mime: "image/png" };
}

describe("useChatDrafts", () => {
  beforeEach(installStubStorage);
  afterEach(restoreStorage);

  it("shows each session its own draft as the displayed session changes", () => {
    const sessionId = ref("a");
    const { userInput } = useChatDrafts(sessionId);

    userInput.value = "written in A";
    sessionId.value = "b";
    assert.equal(userInput.value, "");

    userInput.value = "written in B";
    sessionId.value = "a";
    assert.equal(userInput.value, "written in A");
  });

  it("restores the drafts left in storage by a previous page load", () => {
    storage.set(CHAT_DRAFTS_STORAGE_KEY, JSON.stringify({ a: "from last time" }));
    const { userInput } = useChatDrafts(ref("a"));
    assert.equal(userInput.value, "from last time");
  });

  it("keeps attachments per session but never writes them to storage", () => {
    const sessionId = ref("a");
    const { pastedFiles } = useChatDrafts(sessionId);

    pastedFiles.value = [makeFile("a.png")];
    sessionId.value = "b";
    assert.deepEqual(pastedFiles.value, []);

    sessionId.value = "a";
    assert.equal(pastedFiles.value.length, 1);
    assert.equal(storage.get(CHAT_DRAFTS_STORAGE_KEY), undefined);
  });

  it("hands a fresh array to each empty session, so a caller cannot poison the others", () => {
    const sessionId = ref("a");
    const { pastedFiles } = useChatDrafts(sessionId);

    const first = pastedFiles.value;
    first.push(makeFile("sneaky.png"));
    sessionId.value = "b";

    assert.deepEqual(pastedFiles.value, []);
  });

  it("restores a failed send into the session it was composed in, not the one on screen", () => {
    const sessionId = ref("a");
    const { userInput, pastedFiles, restoreDraft } = useChatDrafts(sessionId);

    userInput.value = "";
    sessionId.value = "b";
    userInput.value = "B is writing this";

    restoreDraft("a", "the message that failed to send", [makeFile("failed.png")]);

    assert.equal(userInput.value, "B is writing this");
    assert.deepEqual(pastedFiles.value, []);
    sessionId.value = "a";
    assert.equal(userInput.value, "the message that failed to send");
    assert.equal(pastedFiles.value.length, 1);
  });

  it("hands text typed before the session id arrived to the session that materialises", async () => {
    const sessionId = ref("");
    const { userInput } = useChatDrafts(sessionId);

    userInput.value = "typed while the app was still booting";
    sessionId.value = "a";
    await nextTick();

    assert.equal(userInput.value, "typed while the app was still booting");
  });

  it("appends that text after the draft the session already had restored", async () => {
    storage.set(CHAT_DRAFTS_STORAGE_KEY, JSON.stringify({ a: "from last time" }));
    const sessionId = ref("");
    const { userInput } = useChatDrafts(sessionId);

    userInput.value = "typed while booting";
    sessionId.value = "a";
    await nextTick();

    assert.equal(userInput.value, "from last time\ntyped while booting");
  });

  it("never hands a stray unidentified draft to a later session", async () => {
    const sessionId = ref("");
    const { userInput } = useChatDrafts(sessionId);
    sessionId.value = "a";
    await nextTick();

    sessionId.value = "";
    userInput.value = "written with no session in view";
    sessionId.value = "b";
    await nextTick();

    assert.equal(userInput.value, "");
  });

  it("merges a failed send with whatever the user typed there while it was in flight", () => {
    const sessionId = ref("a");
    const { userInput, pastedFiles, restoreDraft } = useChatDrafts(sessionId);

    userInput.value = "started the next message";
    pastedFiles.value = [makeFile("staged-since.png")];

    restoreDraft("a", "the message that failed to send", [makeFile("failed.png")]);

    assert.equal(userInput.value, "the message that failed to send\nstarted the next message");
    assert.deepEqual(
      pastedFiles.value.map((file) => file.name),
      ["failed.png", "staged-since.png"],
    );
  });

  it("caps staged attachments at the same session count as the text, so neither half grows forever", () => {
    const sessionId = ref("s0");
    const { pastedFiles } = useChatDrafts(sessionId);

    Array.from({ length: 25 }, (_, index) => `s${index}`).forEach((staging) => {
      sessionId.value = staging;
      pastedFiles.value = [makeFile(`${staging}.png`)];
    });

    sessionId.value = "s0";
    assert.deepEqual(pastedFiles.value, []);
    sessionId.value = "s24";
    assert.equal(pastedFiles.value.length, 1);
  });

  it("drops both halves of a deleted session's draft and leaves the others alone", () => {
    const sessionId = ref("a");
    const { userInput, pastedFiles, dropDraft } = useChatDrafts(sessionId);

    userInput.value = "draft A";
    pastedFiles.value = [makeFile("a.png")];
    sessionId.value = "b";
    userInput.value = "draft B";

    dropDraft("a");

    assert.deepEqual(storedDrafts(), { b: "draft B" });
    sessionId.value = "a";
    assert.equal(userInput.value, "");
    assert.deepEqual(pastedFiles.value, []);
  });

  it("does not rewrite storage when the dropped session had no draft", () => {
    const { userInput, dropDraft } = useChatDrafts(ref("a"));
    userInput.value = "draft A";
    const writesAfterTyping = writes;

    dropDraft("never-had-a-draft");

    assert.equal(writes, writesAfterTyping);
  });

  it("survives storage being unavailable, keeping the draft in memory", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
      writable: true,
      configurable: true,
    });

    const { userInput } = useChatDrafts(ref("a"));
    userInput.value = "still typing";
    assert.equal(userInput.value, "still typing");
  });
});
