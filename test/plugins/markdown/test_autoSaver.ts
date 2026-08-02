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

/** A write whose completion the test controls, so a save can be held "in
 *  flight" while the user cancels. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = (delay = DELAY_MS + 5) => new Promise((resolve) => setTimeout(resolve, delay));

describe("createAutoSaver", () => {
  it("writes the scheduled text once the debounce elapses", async () => {
    const writes: string[] = [];
    const saver = createAutoSaver<string | null>({
      delayMs: DELAY_MS,
      isWanted: () => true,
      write: (text) => {
        writes.push(text);
        return Promise.resolve();
      },
    });

    saver.schedule("hello", "doc.md");
    await tick();
    await saver.settled();

    assert.deepEqual(writes, ["hello"]);
  });

  it("debounces: only the last scheduled text is written", async () => {
    const writes: string[] = [];
    const saver = createAutoSaver<string | null>({
      delayMs: DELAY_MS,
      isWanted: () => true,
      write: (text) => {
        writes.push(text);
        return Promise.resolve();
      },
    });

    saver.schedule("a", "doc.md");
    saver.schedule("ab", "doc.md");
    saver.schedule("abc", "doc.md");
    await tick();
    await saver.settled();

    assert.deepEqual(writes, ["abc"]);
  });

  it("cancel() drops a write still waiting out the debounce", async () => {
    const writes: string[] = [];
    const saver = createAutoSaver<string | null>({
      delayMs: DELAY_MS,
      isWanted: () => true,
      write: (text) => {
        writes.push(text);
        return Promise.resolve();
      },
    });

    saver.schedule("discard me", "doc.md");
    saver.cancel();
    await tick();
    await saver.settled();

    assert.deepEqual(writes, []);
  });

  it("does not persist a queued write once auto save is switched off mid-flight", async () => {
    // The regression: a first save is in flight, a second is already chained
    // behind it, and the user then presses Cancel. `cancel()` cannot reach the
    // chained write — `isWanted` has to refuse it when it runs.
    const writes: string[] = [];
    const inFlight = deferred();
    let wanted = true;

    const saver = createAutoSaver<string | null>({
      delayMs: DELAY_MS,
      isWanted: () => wanted,
      write: (text) => {
        writes.push(text);
        // Only the first write is held open; later ones resolve immediately.
        return writes.length === 1 ? inFlight.promise : Promise.resolve();
      },
    });

    saver.schedule("first", "doc.md");
    await tick();
    assert.deepEqual(writes, ["first"], "the first write should have started");

    // Second write queues behind the one still in flight.
    saver.schedule("second", "doc.md");
    await tick();
    assert.deepEqual(writes, ["first"], "the second write must wait for the first");

    // User presses Cancel / unticks auto save while the first write is open.
    wanted = false;
    saver.cancel();

    inFlight.resolve();
    await saver.settled();

    assert.deepEqual(writes, ["first"], "the queued write must not reach disk after cancel");
  });

  it("does not write a queued buffer into a different document", async () => {
    // Same shape, but the user switches documents rather than cancelling: the
    // buffer belongs to `first.md` and must not be written to `second.md`.
    const writes: [string, string | null][] = [];
    const inFlight = deferred();
    let selected: string | null = "first.md";

    const saver = createAutoSaver<string | null>({
      delayMs: DELAY_MS,
      isWanted: (target) => target === selected,
      write: (text, target) => {
        writes.push([text, target]);
        return writes.length === 1 ? inFlight.promise : Promise.resolve();
      },
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
