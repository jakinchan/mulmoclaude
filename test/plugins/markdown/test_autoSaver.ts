// The cancellation boundary of the presentDocument editor's auto save
// (`createAutoSaver` in `@mulmoclaude/markdown-plugin`).
//
// The rule under test is the one that regressed during review of #2751:
// clearing the debounce timer stops a write that is still waiting, but NOT one
// already handed to the write chain behind an in-flight save. Only the
// `isWanted` re-check at execution time can stop that one — so pressing Cancel
// (or unticking auto save / live preview) while a save is in flight must not
// let the queued buffer reach disk afterwards.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAutoSaver } from "@mulmoclaude/markdown-plugin";

const DELAY_MS = 1;

const tick = (delay = DELAY_MS + 5) => new Promise((resolve) => setTimeout(resolve, delay));

/** A write whose completion the test controls, so a save can be held "in
 *  flight" while the user cancels or switches documents. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface TrackedSaverOptions {
  isWanted?: (target: string | null) => boolean;
  /** Outcome of the nth write (1-based), for holding one open or failing it. */
  onWrite?: (nth: number) => Promise<unknown>;
}

/** A saver that records every (text, target) it writes. */
function trackingSaver(options: TrackedSaverOptions = {}) {
  const writes: [string, string | null][] = [];
  const saver = createAutoSaver<string | null>({
    delayMs: DELAY_MS,
    isWanted: options.isWanted ?? (() => true),
    write: (text, target) => {
      writes.push([text, target]);
      return options.onWrite?.(writes.length) ?? Promise.resolve();
    },
  });
  return { saver, writes, texts: () => writes.map(([text]) => text) };
}

describe("createAutoSaver", () => {
  it("writes the scheduled text once the debounce elapses", async () => {
    const { saver, texts } = trackingSaver();

    saver.schedule("hello", "doc.md");
    await saver.settled();

    assert.deepEqual(texts(), ["hello"]);
  });

  it("debounces: only the last scheduled text is written", async () => {
    const { saver, texts } = trackingSaver();

    saver.schedule("a", "doc.md");
    saver.schedule("ab", "doc.md");
    saver.schedule("abc", "doc.md");
    await saver.settled();

    assert.deepEqual(texts(), ["abc"]);
  });

  it("cancel() drops a write still waiting out the debounce", async () => {
    const { saver, texts } = trackingSaver();

    saver.schedule("discard me", "doc.md");
    saver.cancel();
    await tick();
    await saver.settled();

    assert.deepEqual(texts(), []);
  });

  it("does not persist a queued write once auto save is switched off mid-flight", async () => {
    // The regression: a first save is in flight, a second is already chained
    // behind it, and the user then presses Cancel. `cancel()` cannot reach the
    // chained write — `isWanted` has to refuse it when it runs.
    const inFlight = deferred();
    let wanted = true;
    const { saver, texts } = trackingSaver({
      isWanted: () => wanted,
      onWrite: (nth) => (nth === 1 ? inFlight.promise : Promise.resolve()),
    });

    saver.schedule("first", "doc.md");
    await tick();
    assert.deepEqual(texts(), ["first"], "the first write should have started");

    saver.schedule("second", "doc.md");
    await tick();
    assert.deepEqual(texts(), ["first"], "the second write must wait for the first");

    // User presses Cancel / unticks auto save while the first write is open.
    wanted = false;
    saver.cancel();
    inFlight.resolve();
    await saver.settled();

    assert.deepEqual(texts(), ["first"], "the queued write must not reach disk after cancel");
  });

  it("keeps saving after a write fails", async () => {
    // A rejected write used to leave the internal chain rejected, so every
    // later `.then` was skipped and auto save was dead for the session.
    const { saver, texts } = trackingSaver({
      onWrite: (nth) => (nth === 1 ? Promise.reject(new Error("disk on fire")) : Promise.resolve()),
    });

    saver.schedule("fails", "doc.md");
    await saver.settled();
    saver.schedule("succeeds", "doc.md");
    await saver.settled();

    assert.deepEqual(texts(), ["fails", "succeeds"]);
  });

  it("settled() waits for a write still inside the debounce window", async () => {
    // Without the debounce phase folded in, `settled()` resolved immediately
    // for a scheduled-but-not-yet-queued write — teardown could run first.
    const { saver, texts } = trackingSaver();

    saver.schedule("not queued yet", "doc.md");
    await saver.settled();

    assert.deepEqual(texts(), ["not queued yet"]);
  });

  it("settled() resolves for a cancelled debounce rather than hanging", async () => {
    const { saver, texts } = trackingSaver();

    saver.schedule("dropped", "doc.md");
    saver.cancel();
    // The race is what catches a hang: an unresolved `settled()` would
    // otherwise sit here until the test runner's timeout.
    const outcome = await Promise.race([saver.settled().then(() => "settled"), tick(50).then(() => "hung")]);

    assert.equal(outcome, "settled");
    assert.deepEqual(texts(), []);
  });

  it("does not write a queued buffer into a different document", async () => {
    // Same shape as the cancel case, but the user switches documents: the
    // buffer belongs to `first.md` and must not be written to `second.md`.
    const inFlight = deferred();
    let selected: string | null = "first.md";
    const { saver, writes } = trackingSaver({
      isWanted: (target) => target === selected,
      onWrite: (nth) => (nth === 1 ? inFlight.promise : Promise.resolve()),
    });

    saver.schedule("first doc body", "first.md");
    await tick();
    saver.schedule("first doc body, edited", "first.md");
    await tick();

    selected = "second.md";
    inFlight.resolve();
    await saver.settled();

    assert.deepEqual(writes, [["first doc body", "first.md"]]);
  });
});
