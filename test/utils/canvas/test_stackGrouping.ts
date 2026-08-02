import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStackDisplayItems, pickActiveCardUuid, resolveLatestScrollTarget } from "../../../src/utils/canvas/stackGrouping.js";

// Minimal result shape the grouper needs.
interface Row {
  uuid: string;
  group: string | null;
}
const groupKeyOf = (row: Row): string | null => row.group;
const uuidOf = (row: Row): string => row.uuid;
const build = (rows: Row[]) => buildStackDisplayItems(rows, groupKeyOf, uuidOf);

describe("buildStackDisplayItems", () => {
  it("keeps ungrouped results as one card each, in order", () => {
    const items = build([
      { uuid: "a", group: null },
      { uuid: "b", group: null },
    ]);
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((item) => item.head.uuid),
      ["a", "b"],
    );
    assert.equal(
      items.every((i) => !i.isGroup),
      true,
    );
    assert.equal(
      items.every((item) => item.members.length === 1),
      true,
    );
  });

  it("collapses consecutive same-group results into one card with members in order", () => {
    const items = build([
      { uuid: "a", group: "g1" },
      { uuid: "b", group: "g1" },
      { uuid: "c", group: "g1" },
    ]);
    assert.equal(items.length, 1);
    const [card] = items;
    assert.ok(card);
    assert.equal(card.isGroup, true);
    assert.deepEqual(
      card.members.map((member) => member.uuid),
      ["a", "b", "c"],
    );
    assert.equal(card.head.uuid, "c", "head is the latest member");
    assert.equal(card.key, "group:g1");
  });

  it("merges NON-contiguous same-group results at the first occurrence (Codex #1504)", () => {
    // A(g1), B(text), C(g1) → two cards: the g1 group [A, C] at index 0
    // (A's slot), and B at index 1. C must NOT create a third card, and
    // the group must stay at A's position so rendered order is
    // [g1, B] — what scroll-spy iterates.
    const items = build([
      { uuid: "a", group: "g1" },
      { uuid: "b", group: null },
      { uuid: "c", group: "g1" },
    ]);
    assert.equal(items.length, 2, "C merges into the existing g1 card, not a new one");
    const [groupCard, bCard] = items;
    assert.ok(groupCard);
    assert.ok(bCard);
    assert.equal(groupCard.key, "group:g1");
    assert.deepEqual(
      groupCard.members.map((member) => member.uuid),
      ["a", "c"],
    );
    assert.equal(groupCard.head.uuid, "c", "head follows the latest call");
    assert.equal(bCard.head.uuid, "b");
    assert.equal(bCard.isGroup, false);
  });

  it("keeps distinct groups as distinct cards in first-occurrence order", () => {
    const items = build([
      { uuid: "a", group: "g1" },
      { uuid: "b", group: "g2" },
      { uuid: "c", group: "g1" },
      { uuid: "d", group: "g2" },
    ]);
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((item) => item.key),
      ["group:g1", "group:g2"],
    );
    const [g1Card, g2Card] = items;
    assert.ok(g1Card);
    assert.ok(g2Card);
    assert.deepEqual(
      g1Card.members.map((member) => member.uuid),
      ["a", "c"],
    );
    assert.deepEqual(
      g2Card.members.map((member) => member.uuid),
      ["b", "d"],
    );
  });

  it("treats a lone grouped result as a (single-member) group card", () => {
    const items = build([{ uuid: "a", group: "g1" }]);
    assert.equal(items.length, 1);
    const [card] = items;
    assert.ok(card);
    assert.equal(card.isGroup, true);
    assert.equal(card.members.length, 1);
  });
});

// Behaviour-level regression for the scroll-spy / latest-scroll logic
// that previously assumed `toolResults` order == DOM order (Codex
// #1504). Both helpers are exercised over the non-contiguous sequence
// `A(g1), B, C(g1)` — the exact shape that broke — driven through the
// real `buildStackDisplayItems` projection, not hand-built cards.
describe("pickActiveCardUuid (scroll-spy over rendered card order)", () => {
  // A(g1), B, C(g1) renders as two cards: [group g1 (head C), B]. The
  // group card sits at A's slot (top), B below it.
  const items = build([
    { uuid: "a", group: "g1" },
    { uuid: "b", group: null },
    { uuid: "c", group: "g1" },
  ]);
  // Card → simulated top-edge px. The group card is keyed by its HEAD
  // uuid ("c") — that is what `pickActiveCardUuid` resolves against.
  const GROUP_CARD_TOP_PX = 0;
  const B_CARD_TOP_PX = 100;
  const topOfCardPx = (headUuid: string): number | null => {
    if (headUuid === "c") return GROUP_CARD_TOP_PX;
    if (headUuid === "b") return B_CARD_TOP_PX;
    return null;
  };

  it("returns B (not the group's member C) when the viewport sits on B", () => {
    // Padded line below both cards → last card at/above the line wins.
    // The flat-walk regression returned C here because C's uuid mapped
    // back to the group element above B.
    const active = pickActiveCardUuid(items, (row) => row.uuid, topOfCardPx, B_CARD_TOP_PX + 10);
    assert.equal(active, "b");
  });

  it("returns the group's canonical (head) uuid when only the group card is above the line", () => {
    const active = pickActiveCardUuid(items, (row) => row.uuid, topOfCardPx, B_CARD_TOP_PX - 10);
    assert.equal(active, "c", "the group card emits its head uuid, never an arbitrary member");
  });

  it("returns null when no card has been mounted yet", () => {
    const active = pickActiveCardUuid(
      items,
      (row) => row.uuid,
      () => null,
      999,
    );
    assert.equal(active, null);
  });
});

describe("resolveLatestScrollTarget (latest-result auto-scroll)", () => {
  it("targets the EARLIER group card (not the bottom) when a new result merges into it", () => {
    // A(g1), B, C(g1): C is newest but its card is the group at the
    // TOP. Bottom-scrolling would jump away from where C rendered.
    const rows: Row[] = [
      { uuid: "a", group: "g1" },
      { uuid: "b", group: null },
      { uuid: "c", group: "g1" },
    ];
    const target = resolveLatestScrollTarget(build(rows), rows[rows.length - 1], uuidOf);
    assert.deepEqual(target, { kind: "card", headUuid: "c" });
  });

  it("scrolls to the bottom when the newest result lands in the last card", () => {
    const rows: Row[] = [
      { uuid: "a", group: null },
      { uuid: "b", group: null },
    ];
    const target = resolveLatestScrollTarget(build(rows), rows[rows.length - 1], uuidOf);
    assert.deepEqual(target, { kind: "bottom" });
  });

  it("scrolls to the bottom when the newest result extends a trailing group card", () => {
    const rows: Row[] = [
      { uuid: "a", group: null },
      { uuid: "b", group: "g1" },
      { uuid: "c", group: "g1" },
    ];
    const target = resolveLatestScrollTarget(build(rows), rows[rows.length - 1], uuidOf);
    assert.deepEqual(target, { kind: "bottom" });
  });

  it("returns none when there is no newest result", () => {
    const target = resolveLatestScrollTarget(build([]), undefined, uuidOf);
    assert.deepEqual(target, { kind: "none" });
  });
});
