// Builds the .ico for the generated Windows shortcut.
//
// macOS had `iconutil` to package an .iconset; Windows ships no
// equivalent, so the container is assembled here. Since Vista an ICO
// entry may hold a PNG verbatim rather than a DIB, which is what makes
// this ~20 lines of Buffer writes instead of a bitmap encoder.
//
// Measured on a real windows-latest runner before this was written:
// `System.Drawing.Icon` loads the result and `.lnk` accepts it as an
// IconLocation (see plans/done/feat-2613-launcher-windows.md).

import { writeFile } from "node:fs/promises";

import sharp from "sharp";

import { markSvg } from "../mark.mjs";

// Explorer picks a size per view (list, tiles, jumbo). 256 is the
// largest an ICO can describe — its width/height bytes are single
// bytes, and 0 is the agreed spelling of 256.
const SIZES = [16, 32, 48, 64, 128, 256];
const SIZE_MEANING_256 = 0;
const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;
const ICO_TYPE = 1;
const COLOR_PLANES = 1;
const BITS_PER_PIXEL = 32;

function iconDir(count) {
  const header = Buffer.alloc(ICONDIR_BYTES);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(ICO_TYPE, 2);
  header.writeUInt16LE(count, 4);
  return header;
}

function iconDirEntry({ size, byteLength, offset }) {
  const entry = Buffer.alloc(ICONDIRENTRY_BYTES);
  const dimension = size === 256 ? SIZE_MEANING_256 : size;
  entry.writeUInt8(dimension, 0);
  entry.writeUInt8(dimension, 1);
  entry.writeUInt16LE(COLOR_PLANES, 4);
  entry.writeUInt16LE(BITS_PER_PIXEL, 6);
  entry.writeUInt32LE(byteLength, 8);
  entry.writeUInt32LE(offset, 12);
  return entry;
}

/**
 * Pack already-rendered PNGs into an ICO. Separated from the rendering
 * so the container layout can be asserted without invoking sharp.
 * @param {{ size: number, png: Buffer }[]} images
 * @returns {Buffer}
 */
export function packIco(images) {
  let offset = ICONDIR_BYTES + ICONDIRENTRY_BYTES * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = iconDirEntry({ size, byteLength: png.length, offset });
    offset += png.length;
    return entry;
  });
  return Buffer.concat([iconDir(images.length), ...entries, ...images.map(({ png }) => png)]);
}

/**
 * Write an .ico at `targetPath`. Returns false instead of throwing, for
 * the same reason `buildIcns` does: a shortcut with the generic icon
 * still launches, and losing the launcher over its artwork would be
 * absurd.
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
export async function buildIco(targetPath) {
  try {
    const source = Buffer.from(markSvg());
    const images = await Promise.all(SIZES.map(async (size) => ({ size, png: await sharp(source).resize(size, size).png().toBuffer() })));
    await writeFile(targetPath, packIco(images));
    return true;
  } catch {
    return false;
  }
}
