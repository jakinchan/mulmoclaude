// Builds the .icns for the generated app bundle.
//
// The artwork itself lives in `../mark.mjs`, shared with the Windows
// .ico builder so the app cannot end up with two different faces.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { markSvg } from "../mark.mjs";

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
