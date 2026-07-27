// Tests for `server/utils/launcher/windows/icon.mjs`.
//
// Windows ships no `iconutil`, so the launcher writes the ICO container
// itself. Parsing the bytes back is the only way to catch an offset or
// length that is wrong by a few bytes — a broken container does not
// throw, it just makes Explorer fall back to a blank icon.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildIco, packIco } from "../../../server/utils/launcher/windows/icon.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ParsedEntry {
  width: number;
  height: number;
  byteLength: number;
  offset: number;
}

// Reads the container the way Windows would, rather than trusting the
// writer's own arithmetic.
const parseIco = (buffer: Buffer): { type: number; entries: ParsedEntry[] } => {
  const count = buffer.readUInt16LE(4);
  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = ICONDIR_BYTES + i * ICONDIRENTRY_BYTES;
    entries.push({
      width: buffer.readUInt8(offset),
      height: buffer.readUInt8(offset + 1),
      byteLength: buffer.readUInt32LE(offset + 8),
      offset: buffer.readUInt32LE(offset + 12),
    });
  }
  return { type: buffer.readUInt16LE(2), entries };
};

const fakePng = (byte: number, length: number): Buffer => Buffer.concat([PNG_MAGIC, Buffer.alloc(length - PNG_MAGIC.length, byte)]);

describe("packIco", () => {
  it("points every entry at its own image", () => {
    const images = [
      { size: 16, png: fakePng(0x01, 40) },
      { size: 32, png: fakePng(0x02, 90) },
      { size: 256, png: fakePng(0x03, 30) },
    ];
    const ico = packIco(images);
    const { type, entries } = parseIco(ico);

    assert.equal(type, 1, "type 1 is ICO; 2 would be CUR (a cursor)");
    assert.equal(entries.length, images.length);
    entries.forEach((entry, i) => {
      const slice = ico.subarray(entry.offset, entry.offset + entry.byteLength);
      assert.deepEqual(slice, images[i].png, `entry ${i} does not point at its own bytes`);
    });
  });

  it("spells 256 as 0 — the dimension fields are single bytes", () => {
    const { entries } = parseIco(packIco([{ size: 256, png: fakePng(0x01, 20) }]));
    assert.equal(entries[0].width, 0);
    assert.equal(entries[0].height, 0);
  });

  it("leaves no gap or overlap between images", () => {
    const images = [16, 32, 48].map((size, i) => ({ size, png: fakePng(i, 20 + i * 10) }));
    const ico = packIco(images);
    const { entries } = parseIco(ico);
    let expected = ICONDIR_BYTES + ICONDIRENTRY_BYTES * images.length;
    entries.forEach((entry) => {
      assert.equal(entry.offset, expected);
      expected += entry.byteLength;
    });
    assert.equal(ico.length, expected, "trailing bytes mean an entry length is wrong");
  });
});

describe("buildIco", () => {
  it("writes a file every entry of which is a real PNG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mulmoclaude-ico-"));
    try {
      const target = join(dir, "icon.ico");
      assert.equal(await buildIco(target), true);
      const ico = readFileSync(target);
      const { entries } = parseIco(ico);
      assert.ok(entries.length > 1, "Explorer picks a size per view, so one entry is not enough");
      entries.forEach((entry) => {
        const magic = ico.subarray(entry.offset, entry.offset + PNG_MAGIC.length);
        assert.deepEqual(magic, PNG_MAGIC, "PNG-compressed entries are what makes this container writable by hand");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports failure instead of throwing when the path is unwritable", async () => {
    // Losing the whole launcher over its artwork would be absurd, so the
    // caller is told and carries on with the generic icon.
    assert.equal(await buildIco(join(tmpdir(), "mulmoclaude-missing-dir", "nested", "icon.ico")), false);
  });
});
