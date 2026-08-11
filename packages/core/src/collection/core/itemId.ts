/**
 * A generated record id: a v4 UUID with its hyphens stripped — 32 lowercase hex
 * characters, 122 bits.
 *
 * The ONE generator behind both blank-id create paths — the server's
 * `generateItemId()` (../server/io) delegates here, so the UI's pre-filled id
 * and the id a blank-id POST mints are the same thing rather than two
 * implementations that have to agree.
 *
 * It replaced an 8-hex-char id, whose 32 bits collided at a 1.2% rate across
 * 10k records — and a collision surfaced as `item '<id>' already exists`, which
 * named a duplicate that did not exist (#2851).
 *
 * **The hyphens have to go.** A record id in a `googleCalendar` collection is
 * sent to Google as the caller-chosen event id, and Google takes base32hex only
 * (`isClientSettableEventId`, ../../google/pushPlan) — a hyphenated UUID is
 * refused, so every UI-created record would push as "the record id cannot be
 * used as a Google event id". Hex is a subset of base32hex, so the stripped
 * form satisfies both that and `SAFE_RECORD_ID_PATTERN` (the id is also the
 * `<id>.json` filename stem).
 */
export function newItemId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** @deprecated Use {@link newItemId}. Kept as a compatibility export because
 *  `@mulmoclaude/core/collection` is public API (same reason as
 *  `CollectionActionWhen` in ./schema). It is the NEW generator, not the old
 *  8-hex one: that width is the bug #2851 reported, and leaving a copy of it
 *  reachable under an old name would keep shipping it. */
export const shortHexId = newItemId;
