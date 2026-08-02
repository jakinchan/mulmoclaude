// Throttle concurrency invariant — the SEC's 10 req/s cap is
// non-negotiable, so the throttle MUST serialise concurrent
// callers (no overlapping work, ≥ MIN_INTERVAL_MS gap between
// release timestamps).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MIN_INTERVAL_MS, throttledSlot } from "../src/edgar";

type Interval = { start: number; end: number };

const WORK_DURATION_MS = 10;
const GAP_SLACK_MS = 5;

/** Folds over adjacent pairs; the seed keeps the first element from being compared with nothing. */
const forEachAdjacentPair = (intervals: Interval[], visit: (previous: Interval, current: Interval, index: number) => void): void => {
  intervals.reduce<Interval | undefined>((previous, current, index) => {
    if (previous) visit(previous, current, index);
    return current;
  }, undefined);
};

const assertNoOverlap = (intervals: Interval[]): void =>
  forEachAdjacentPair(intervals, (previous, current, index) => {
    assert.ok(
      current.start >= previous.end,
      `interval ${index} (${current.start}–${current.end}) overlaps interval ${index - 1} (${previous.start}–${previous.end})`,
    );
  });

const assertGapsAtLeastMinInterval = (intervals: Interval[]): void =>
  forEachAdjacentPair(intervals, (previous, current, index) => {
    const gap = current.start - previous.start;
    assert.ok(gap >= MIN_INTERVAL_MS - GAP_SLACK_MS, `gap ${gap}ms between starts ${index - 1}→${index} is below MIN_INTERVAL_MS (${MIN_INTERVAL_MS}ms)`);
  });

describe("edgar throttledSlot — concurrency safety", () => {
  it("serialises N parallel callers (no overlap, gaps ≥ MIN_INTERVAL_MS)", async () => {
    const intervals: Interval[] = [];
    const startedAt = Date.now();

    const work = async (): Promise<void> => {
      const start = Date.now() - startedAt;
      await new Promise((resolve) => setTimeout(resolve, WORK_DURATION_MS));
      intervals.push({ start, end: Date.now() - startedAt });
    };

    await Promise.all([throttledSlot(work), throttledSlot(work), throttledSlot(work), throttledSlot(work), throttledSlot(work)]);

    assertNoOverlap(intervals);
    assertGapsAtLeastMinInterval(intervals);
  });

  it("a thrown handler does not poison the chain", async () => {
    const calls: string[] = [];

    const ok = async (label: string): Promise<string> => {
      calls.push(label);
      return label;
    };

    const failing = throttledSlot(async () => {
      throw new Error("boom");
    });
    const after = throttledSlot(() => ok("after"));

    await assert.rejects(failing, /boom/);
    const result = await after;
    assert.equal(result, "after");
    assert.deepEqual(calls, ["after"]);
  });
});
