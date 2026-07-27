// Builds the .icns for the generated app bundle.
//
// The artwork is the same mark the web app uses for its favicon (see
// index.html): a rounded grey square with a white M. Drawn here as a
// stroked path rather than an SVG <text> element — text would depend on
// whichever font the rasteriser happens to pick, and the mark has to
// look identical on every machine.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

const CANVAS = 1024;
const MARK_BACKGROUND = "#6B7280";
// macOS icons sit inset from the canvas edge; ~9% keeps the mark clear
// of the Dock's own spacing without looking lost.
const INSET = 96;
const CORNER_RADIUS = 208;

// Rendered sizes an .iconset must contain, as [pixels, filename].
const ICONSET_ENTRIES = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

/** The mark as a standalone SVG document. */
export function markSvg() {
  const size = CANVAS - INSET * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <rect x="${INSET}" y="${INSET}" width="${size}" height="${size}" rx="${CORNER_RADIUS}" fill="${MARK_BACKGROUND}"/>
  <path d="M 300 690 L 300 340 L 512 560 L 724 340 L 724 690" fill="none" stroke="#ffffff"
        stroke-width="96" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

async function writeIconsetPngs(iconsetDir, svg) {
  const source = Buffer.from(svg);
  await Promise.all(ICONSET_ENTRIES.map(([pixels, filename]) => sharp(source).resize(pixels, pixels).png().toFile(join(iconsetDir, filename))));
}

/**
 * Write an .icns at `targetPath`. Returns false instead of throwing when
 * the toolchain is unavailable — an app bundle with a generic icon still
 * launches, and losing the launcher over its artwork would be absurd.
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
export async function buildIcns(targetPath) {
  const workDir = mkdtempSync(join(tmpdir(), "mulmoclaude-icon-"));
  const iconsetDir = join(workDir, "icon.iconset");
  try {
    mkdirSync(iconsetDir, { recursive: true });
    await writeIconsetPngs(iconsetDir, markSvg());
    execFileSync("/usr/bin/iconutil", ["-c", "icns", iconsetDir, "-o", targetPath], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
