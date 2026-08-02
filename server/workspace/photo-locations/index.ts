// Photo-EXIF sidecar persistence for #1222 PR-A.
//
// One JSON file per saved attachment, written immediately after the
// attachment lands. The sidecar lives under
//   `data/locations/<YYYY>/<MM>/<attachment-id>.json`
// mirroring the attachment partition so a photo and its location
// metadata are co-located on disk (handy for filesystem-based
// browsing in Finder / Obsidian).
//
// Shape goal: lat/lng are top-level numbers so an LLM can hand the
// sidecar straight to `mapControl({ action: "addMarker", lat, lng })`
// from the Google Map plugin (#1227) without any reshape. The hook
// runs only when the attachment has a parseable EXIF block AND
// auto-capture is enabled in `AppSettings.photoExif`.

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { writeFileAtomic } from "../../utils/files/atomic.js";
import { WORKSPACE_PATHS, WORKSPACE_DIRS } from "../paths.js";
import { isPhotoExifAutoCaptureEnabled, loadSettings } from "../../system/config.js";
import { isExifSupportedMime, readPhotoExif, type ExifParser, type PhotoExif } from "../../utils/exif.js";
import { log } from "../../system/logger/index.js";
import { publishPhotoLocationsChanged } from "../../events/photo-locations-change.js";

/** Persisted sidecar shape. */
export interface PhotoLocationSidecar {
  /** Always `1`. Bump when the shape changes incompatibly so
   *  consumers (the future `manageMap`/photo plugin) can detect
   *  legacy files. */
  version: 1;
  /** Pointer back to the photo this sidecar describes. Workspace-
   *  relative, posix slashes. */
  photo: {
    relativePath: string;
    mimeType: string;
  };
  /** Selected EXIF fields. See `PhotoExif` for the full surface. */
  exif: PhotoExif;
  /** ISO timestamp marking when the sidecar was written (i.e. when
   *  the photo was received, not when the photo was shot — the
   *  shutter time lives in `exif.takenAt`). */
  capturedAt: string;
}

const SIDECAR_FILE_MODE = 0o600;

/** Strip the extension from `<id>.<ext>`. The basename without
 *  extension is the sidecar id. */
function sidecarIdForAttachment(attachmentRelativePath: string): string {
  const base = path.posix.basename(attachmentRelativePath);
  const ext = path.posix.extname(base);
  return ext.length > 0 ? base.slice(0, -ext.length) : base;
}

/** YYYY/MM partition fragment of a workspace-relative attachment
 *  path: `data/attachments/2026/05/foo.jpg` → `2026/05`. Falls back
 *  to the empty string when the path is shorter than expected (the
 *  caller treats that as "skip this attachment"). */
function partitionForAttachment(attachmentRelativePath: string): string {
  const segments = attachmentRelativePath.split("/").filter(Boolean);
  // segments = [data, attachments, YYYY, MM, filename]
  if (segments.length < 5) return "";
  const [, , year, month] = segments;
  if (year === undefined || month === undefined) return "";
  return path.posix.join(year, month);
}

/** Compute the absolute sidecar path for a saved attachment. */
export function sidecarPathForAttachment(attachmentRelativePath: string): string | null {
  const partition = partitionForAttachment(attachmentRelativePath);
  if (partition === "") return null;
  const sidecarId = sidecarIdForAttachment(attachmentRelativePath);
  return path.join(WORKSPACE_PATHS.locations, partition, `${sidecarId}.json`);
}

/** Hook the attachment-store calls after every saved attachment.
 *  No-op when:
 *    - `AppSettings.photoExif.autoCapture` is `false` (user opt-out)
 *    - the MIME type isn't an image format exifr understands
 *    - the photo has no parseable EXIF (screenshots etc.)
 *
 *  Errors are swallowed and logged at warn — we never want a failed
 *  EXIF probe to fail the upload. */
export function capturePhotoLocation(absPhotoPath: string, attachmentRelativePath: string, mimeType: string): Promise<void> {
  return capturePhotoLocationWithParser(absPhotoPath, attachmentRelativePath, mimeType);
}

/** Gate check: should we even try to read EXIF for this MIME, given
 *  the user's auto-capture setting? Pure — no I/O. */
function shouldCapture(mimeType: string): boolean {
  if (!isExifSupportedMime(mimeType)) return false;
  return isPhotoExifAutoCaptureEnabled(loadSettings());
}

/** Read EXIF, swallowing parser errors as `null`. The hook never
 *  fails the upload — a thrown parser is just "skip the sidecar". */
async function readExifSafe(absPhotoPath: string, attachmentRelativePath: string, parser: ExifParser | undefined): Promise<PhotoExif | null> {
  try {
    return await readPhotoExif(absPhotoPath, parser);
  } catch (err) {
    log.warn("photo-locations", "exif parse threw — skipping sidecar", { path: attachmentRelativePath, error: String(err) });
    return null;
  }
}

/** Write the sidecar JSON, creating parent dirs as needed. Failures
 *  are logged but never thrown — the photo upload already succeeded
 *  by the time this runs. */
async function writeSidecarSafe(sidecarPath: string, payload: PhotoLocationSidecar): Promise<void> {
  try {
    await mkdir(path.dirname(sidecarPath), { recursive: true });
    await writeFileAtomic(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: SIDECAR_FILE_MODE });
    log.info("photo-locations", "sidecar written", {
      attachment: payload.photo.relativePath,
      hasGps: payload.exif.lat !== undefined && payload.exif.lng !== undefined,
    });
    // Nudge an open photoLocations View to refetch without polling.
    publishPhotoLocationsChanged();
  } catch (err) {
    log.warn("photo-locations", "sidecar write failed", { attachmentRelativePath: payload.photo.relativePath, error: String(err) });
  }
}

/** Parser-injectable variant. Production code uses
 *  `capturePhotoLocation`; tests reach for this overload to swap
 *  exifr for a stub so they don't need a JPEG fixture. */
export async function capturePhotoLocationWithParser(
  absPhotoPath: string,
  attachmentRelativePath: string,
  mimeType: string,
  parser?: ExifParser,
): Promise<void> {
  if (!shouldCapture(mimeType)) return;
  const exif = await readExifSafe(absPhotoPath, attachmentRelativePath, parser);
  if (!exif) return;
  const sidecarPath = sidecarPathForAttachment(attachmentRelativePath);
  if (!sidecarPath) {
    log.warn("photo-locations", "could not derive sidecar path — skipping", { attachmentRelativePath });
    return;
  }
  const payload: PhotoLocationSidecar = {
    version: 1,
    photo: { relativePath: attachmentRelativePath, mimeType },
    exif,
    capturedAt: new Date().toISOString(),
  };
  await writeSidecarSafe(sidecarPath, payload);
}

// `WORKSPACE_DIRS.locations` is referenced for typing-side
// completeness — stops `WORKSPACE_DIRS` from being tree-shaken out
// of test bundles that import this module without explicitly using
// the alias.
export const LOCATIONS_DIR_KEY = WORKSPACE_DIRS.locations;
