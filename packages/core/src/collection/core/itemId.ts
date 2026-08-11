/**
 * A generated record id: a v4 UUID.
 *
 * The ONE generator behind both blank-id create paths — the server's
 * `generateItemId()` (../server/io) delegates here, so the UI's pre-filled id
 * and the id a blank-id POST mints are the same thing rather than two
 * implementations that have to agree.
 *
 * A UUID passes `SAFE_RECORD_ID_PATTERN` unchanged (hex start and end, hyphens
 * interior), so it is a legal filename stem for `<id>.json`. It replaced an
 * 8-hex-char id, whose 32 bits collided at a 1.2% rate across 10k records —
 * and a collision surfaced as `item '<id>' already exists`, which named a
 * duplicate that did not exist (#2851).
 */
export function newItemId(): string {
  return crypto.randomUUID();
}
