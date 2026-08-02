// Thin wrapper around `exifr` for the photo-location capture flow
// (#1222 PR-A).
//
// Why a wrapper:
//   - `exifr.parse(...)` returns `unknown`-shaped data; everything
//     except a tight allow-list is noise. Centralise the projection
//     so the hook stays simple and the sidecar shape is the single
//     source of truth.
//   - exifr throws on malformed input. Tested call sites convert
//     "no exif" / "corrupt jpeg" / "wrong mime" to a `null` return
//     so the post-save hook never has to try/catch.
//
// Output is shape-compatible with `mapControl({ action: "addMarker",
// lat, lng })` so the LLM (and any future view) can pass the
// extracted coords straight to the Google Map plugin without a
// reshape (#1227).

import { readFile } from "fs/promises";
import exifr from "exifr";
import { isRecord } from "./types.js";

/** Extracted, projected EXIF fields. All optional — most photos have
 *  some subset. Persisted as the sidecar JSON shape; consumers can
 *  rely on `lat` + `lng` being absent together (never one without
 *  the other). */
export interface PhotoExif {
  // ── Location ────────────────────────────────────────────────
  /** Latitude in WGS84 decimal degrees. */
  lat?: number;
  /** Longitude in WGS84 decimal degrees. */
  lng?: number;
  /** GPS altitude in metres above sea level. */
  altitude?: number;
  /** Horizontal positioning error in metres (smaller = more
   *  accurate). Useful for rendering an accuracy circle on a map
   *  rather than a point. iPhone fills this in. */
  hPositioningError?: number;
  /** Compass heading the camera was pointing, in degrees from true
   *  north (0 = N, 90 = E, …). Useful for "which way was I looking"
   *  on a map view. */
  heading?: number;
  /** Speed in km/h when the photo was taken. Almost always 0 for a
   *  stationary shutter, but non-zero on photos snapped from a
   *  moving train / car / plane. */
  speed?: number;

  // ── Time ────────────────────────────────────────────────────
  /** ISO 8601 capture timestamp (UTC). exifr normalises any of the
   *  three EXIF date fields (DateTimeOriginal / DateTime /
   *  CreateDate) to a JS Date — we serialise to ISO for storage. */
  takenAt?: string;

  // ── Body + lens ─────────────────────────────────────────────
  /** Camera make (e.g. "Apple"). */
  make?: string;
  /** Camera model (e.g. "iPhone 15 Pro"). */
  model?: string;
  /** Lens model (e.g. "iPhone 15 Pro back triple camera"). */
  lens?: string;
  /** Editing software ("Photos 5.0", "Adobe Lightroom"). */
  software?: string;

  // ── Exposure (the photographic basics) ──────────────────────
  /** Shutter speed in seconds (e.g. 0.008333 = 1/120). */
  exposureTime?: number;
  /** Aperture f-number (e.g. 1.78). */
  fNumber?: number;
  /** ISO sensitivity (e.g. 64). */
  iso?: number;
  /** Focal length in mm (sensor-native, NOT 35mm-equivalent). */
  focalLength?: number;
  /** Focal length normalised to 35mm-equivalent — the comparable
   *  number across sensors of different sizes. */
  focalLength35mm?: number;
  /** True when the flash actually fired. The EXIF Flash byte's
   *  bit 0 ("Flash fired") is what we surface; the rest of the
   *  byte (return mode, red-eye, etc.) is dropped. */
  flashFired?: boolean;

  // ── Image ───────────────────────────────────────────────────
  /** Pixel width — handy for sizing a thumbnail without decoding
   *  the bytes. */
  width?: number;
  /** Pixel height. */
  height?: number;
  /** Image orientation (1-8 per the EXIF spec) — useful when a
   *  later view renders the photo without going through a tag-aware
   *  decoder. */
  orientation?: number;
}

const VALID_LAT_MIN = -90;
const VALID_LAT_MAX = 90;
const VALID_LNG_MIN = -180;
const VALID_LNG_MAX = 180;

const PARSE_OPTIONS = {
  // exifr's "tiff" group covers DateTime / Make / Model / Orientation;
  // "exif" covers DateTimeOriginal / Lens; "gps" covers latitude /
  // longitude / altitude. Skip the rest (XMP, IPTC, ICC, thumbnails)
  // — they bloat the parse and we don't store any of it.
  tiff: true,
  exif: true,
  gps: true,
  xmp: false,
  iptc: false,
  icc: false,
  jfif: false,
  ihdr: false,
  // No `pick` here. `pick` filters tags BEFORE exifr's post-
  // processors run, which means picking the derived names
  // `latitude` / `longitude` actually drops the raw `GPSLatitude`
  // / `GPSLatitudeRef` / `GPSLongitude` / `GPSLongitudeRef` tags
  // the converter needs — so the sidecar would lose lat/lng while
  // still picking up `GPSAltitude` (a raw tag that exifr renames
  // 1:1, no derivation). Reproducer: an iPhone HEIC with full GPS
  // emitted only `altitude` + camera fields, no `lat` / `lng`
  // (#1222 PR-A follow-up). The size win was small; correctness
  // wins.
};

/** Validate a `(lat, lng)` pair. exifr occasionally surfaces 0/0
 *  for photos with a zeroed-out GPS block (sometimes seen on Android
 *  exports where the user opted out mid-stream); treating 0/0 as
 *  "no fix" avoids a useless pin in the middle of the Atlantic. */
function isValidCoord(lat: unknown, lng: unknown): lat is number {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < VALID_LAT_MIN || lat > VALID_LAT_MAX) return false;
  if (lng < VALID_LNG_MIN || lng > VALID_LNG_MAX) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

function pickString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pickDate(raw: Record<string, unknown>): string | undefined {
  // Prefer DateTimeOriginal (when the shutter fired) over DateTime
  // (last edit) and CreateDate (file creation). exifr returns a
  // JS Date when the field is parseable; otherwise a string.
  const candidate = raw.DateTimeOriginal ?? raw.CreateDate ?? raw.DateTime;
  if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) {
    return candidate.toISOString();
  }
  return undefined;
}

function pickOrientation(raw: Record<string, unknown>): number | undefined {
  const value = raw.Orientation;
  return typeof value === "number" && value >= 1 && value <= 8 ? value : undefined;
}

/** Lower-level parser injection point. Tests pass a fake to avoid
 *  needing a real JPEG fixture; production paths default to exifr. */
export type ExifParser = (buf: Buffer) => Promise<unknown>;

const defaultParser: ExifParser = (buf) => exifr.parse(buf, PARSE_OPTIONS);

/** Parse a photo file and project the fields we care about. Returns
 *  `null` when the file has no parseable EXIF (screenshots, scrubbed
 *  uploads, non-image MIME types, malformed JPEG). Never throws. */
export async function readPhotoExif(absPath: string, parser: ExifParser = defaultParser): Promise<PhotoExif | null> {
  let raw: unknown;
  try {
    const buf = await readFile(absPath);
    raw = await parser(buf);
  } catch {
    // Includes both fs errors (handler should have ensured the file
    // exists) and exifr "couldn't find any EXIF data" rejections.
    return null;
  }
  if (!isRecord(raw)) return null;
  return projectExif(raw);
}

/** Keep finite numbers in a 0…max range; otherwise undefined. Used
 *  for fields like ISO / heading / focal length where exifr might
 *  hand back a sentinel `0` for an unparseable tag. */
function pickFiniteNumber(value: unknown, opts?: { min?: number; max?: number }): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (opts?.min !== undefined && value < opts.min) return undefined;
  if (opts?.max !== undefined && value > opts.max) return undefined;
  return value;
}

/** Coords + altitude + GPS extras. exifr surfaces these from the
 *  GPS group: `latitude`/`longitude` are derived (lat/lng/Ref/Ref
 *  → decimal), the rest are 1:1 tag renames. */
function pickGps(record: Record<string, unknown>): Pick<PhotoExif, "lat" | "lng" | "altitude" | "hPositioningError" | "heading" | "speed"> {
  const out: Pick<PhotoExif, "lat" | "lng" | "altitude" | "hPositioningError" | "heading" | "speed"> = {};
  if (isValidCoord(record.latitude, record.longitude)) {
    out.lat = record.latitude as number;
    out.lng = record.longitude as number;
  }
  const altitude = pickFiniteNumber(record.GPSAltitude);
  if (altitude !== undefined) out.altitude = altitude;
  const hError = pickFiniteNumber(record.GPSHPositioningError, { min: 0 });
  if (hError !== undefined) out.hPositioningError = hError;
  const heading = pickFiniteNumber(record.GPSImgDirection, { min: 0, max: 360 });
  if (heading !== undefined) out.heading = heading;
  const speed = pickFiniteNumber(record.GPSSpeed, { min: 0 });
  if (speed !== undefined) out.speed = speed;
  return out;
}

/** Camera identification — Make / Model / LensModel / Software.
 *  Empty strings drop out (exifr returns `""` for tags present but
 *  blank). */
function pickCamera(record: Record<string, unknown>): Pick<PhotoExif, "make" | "model" | "lens" | "software"> {
  const out: Pick<PhotoExif, "make" | "model" | "lens" | "software"> = {};
  const make = pickString(record, "Make");
  if (make) out.make = make;
  const model = pickString(record, "Model");
  if (model) out.model = model;
  const lens = pickString(record, "LensModel");
  if (lens) out.lens = lens;
  const software = pickString(record, "Software");
  if (software) out.software = software;
  return out;
}

/** Exposure-triangle fields + flash + focal length. The four
 *  "what camera settings did this photo use" basics — useful for
 *  filtering ("show me my low-light shots") and for an EXIF info
 *  panel later. */
function pickExposure(record: Record<string, unknown>): Pick<PhotoExif, "exposureTime" | "fNumber" | "iso" | "focalLength" | "focalLength35mm" | "flashFired"> {
  const out: Pick<PhotoExif, "exposureTime" | "fNumber" | "iso" | "focalLength" | "focalLength35mm" | "flashFired"> = {};
  const exposureTime = pickFiniteNumber(record.ExposureTime, { min: 0 });
  if (exposureTime !== undefined) out.exposureTime = exposureTime;
  const fNumber = pickFiniteNumber(record.FNumber, { min: 0 });
  if (fNumber !== undefined) out.fNumber = fNumber;
  // exifr normalises both `ISO` (newer) and `ISOSpeedRatings`
  // (older) to a top-level `ISO` field.
  const iso = pickFiniteNumber(record.ISO, { min: 0 });
  if (iso !== undefined) out.iso = iso;
  const focal = pickFiniteNumber(record.FocalLength, { min: 0 });
  if (focal !== undefined) out.focalLength = focal;
  const focal35 = pickFiniteNumber(record.FocalLengthIn35mmFormat, { min: 0 });
  if (focal35 !== undefined) out.focalLength35mm = focal35;
  // exifr post-processes `Flash` into either an object (default) or
  // a number depending on options. We accept either: object → read
  // `.flashfired`/`.flash`, number → bit 0 of the EXIF Flash byte.
  const fired = readFlashFired(record.Flash);
  if (fired !== undefined) out.flashFired = fired;
  return out;
}

/** Read the "flash actually fired" bit from exifr's Flash output —
 *  may be a number (raw EXIF Flash byte; bit 0 = fired) or an
 *  object (post-processed; `.flash` / `.fired` / `.flashfired` in
 *  various exifr versions). */
function readFlashFired(value: unknown): boolean | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return (value & 1) === 1;
  }
  if (isRecord(value)) {
    const candidates = [value.flashfired, value.fired, value.flash];
    for (const candidate of candidates) {
      if (typeof candidate === "boolean") return candidate;
    }
  }
  return undefined;
}

/** Image dimensions. exifr surfaces both `ExifImageWidth` /
 *  `ExifImageHeight` (from the EXIF block) and `ImageWidth` /
 *  `ImageHeight` (from the TIFF block) — prefer the EXIF block
 *  (post-rotation, what a viewer would actually display).
 *  width / height are stored as a pair: a record with only one
 *  of the two is meaningless (a width-without-height won't help
 *  any consumer compute aspect ratio), so both must validate
 *  cleanly or we drop both. */
function pickImage(record: Record<string, unknown>): Pick<PhotoExif, "width" | "height"> {
  const width = pickFiniteNumber(record.ExifImageWidth, { min: 1 }) ?? pickFiniteNumber(record.ImageWidth, { min: 1 });
  const height = pickFiniteNumber(record.ExifImageHeight, { min: 1 }) ?? pickFiniteNumber(record.ImageHeight, { min: 1 });
  if (width === undefined || height === undefined) return {};
  return { width, height };
}

/** Pure projection: take the raw exifr output and pluck the fields
 *  we keep. Exported separately so the hook can run a fake parser
 *  result through the same shaping in tests. */
export function projectExif(record: Record<string, unknown>): PhotoExif | null {
  const takenAt = pickDate(record);
  const orientation = pickOrientation(record);
  const result: PhotoExif = {
    ...pickGps(record),
    ...pickCamera(record),
    ...pickExposure(record),
    ...pickImage(record),
    ...(takenAt !== undefined ? { takenAt } : {}),
    ...(orientation !== undefined ? { orientation } : {}),
  };
  // No useful fields — caller treats the same as "no exif" so the
  // sidecar isn't created with an empty object.
  return Object.keys(result).length === 0 ? null : result;
}

/** True when the MIME type is one exifr can read. Image-only — video
 *  EXIF (MP4 / MOV) is out of scope for PR-A. HEIC is included
 *  because iOS still emits it as the default camera format.
 *
 *  Both `image/jpeg` and the legacy `image/jpg` alias are accepted —
 *  `attachment-store.ts`'s `MIME_EXT` table maps both to `.jpg`, so
 *  uploads labelled `image/jpg` save successfully but were previously
 *  silently skipping EXIF sidecar capture. (Codex review on PR #1247.) */
export function isExifSupportedMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return (
    lower === "image/jpeg" ||
    lower === "image/jpg" ||
    lower === "image/png" ||
    lower === "image/heic" ||
    lower === "image/heif" ||
    lower === "image/tiff" ||
    lower === "image/webp"
  );
}
