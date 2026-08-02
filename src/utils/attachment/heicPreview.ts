// Browser-side HEIC / HEIF → JPEG conversion for the pre-send
// attachment preview (`ChatAttachmentPreview.vue`). Chrome refuses
// to render `image/heic` / `image/heif` in `<img>`, so a user who
// pastes / drops an iPhone photo sees a broken-image icon before
// they send the message.
//
// The server-side upload path is deliberately NOT touched — the
// original HEIC bytes still travel to `/api/attachments` verbatim,
// where a Node-side heic-convert / sharp roundtrip produces the
// JPEG the LLM reads. This module runs entirely in-browser and only
// affects what the user sees in the preview chip.
//
// `heic2any` bundles WASM libheif (~1.5 MB). We dynamic-import it
// on first use so users who never paste HEIC don't pay the
// download / parse cost. Failures are swallowed — the caller then
// leaves `previewDataUrl` unset and the preview component drops
// back to a file-icon chip.

// `image/heic-sequence` / `image/heif-sequence` are the multi-frame
// container MIMEs iOS emits for burst mode and Live Photos. Codex
// review on #2000: without these, a Live Photo would silently miss
// the preview conversion and land in the file-icon fallback.
const HEIF_LIKE_MIMES: ReadonlySet<string> = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);

/** True when the given MIME identifies a HEIC / HEIF variant Chrome
 *  can't render natively (including the `-sequence` container
 *  variants for Live Photos / burst mode). Kept narrow — TIFF / BMP
 *  are technically in-band for the server-side conversion path but
 *  Chrome renders BMP natively today and heic2any doesn't decode
 *  TIFF at all. */
export function needsBrowserPreviewConversion(mime: string): boolean {
  return HEIF_LIKE_MIMES.has(mime);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("FileReader returned non-string")));
    reader.onerror = () => reject(new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

/** Decode a HEIC / HEIF File into a JPEG data URL suitable for
 *  `<img :src>`. Returns null on any decode failure (unsupported
 *  variant, malformed bytes, WASM load failure) — the caller uses
 *  this to leave the preview chip in the file-icon state instead
 *  of a broken image. */
export async function buildHeicPreviewDataUrl(file: File): Promise<string | null> {
  try {
    // heic2any's default export is a function; dynamic import keeps
    // the ~1.5 MB WASM libheif bundle out of the app's initial
    // payload for users who never paste HEIC.
    const heic2any = (await import("heic2any")).default;
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.85 });
    // heic2any returns `Blob | Blob[]` — a multi-frame HEIC / HEIF
    // (burst mode, live photo) returns an array. Take the first
    // frame for the preview; the full sequence still ships as-is to
    // the upload endpoint via the untouched `dataUrl`.
    const jpegBlob = Array.isArray(converted) ? converted[0] : converted;
    // A frameless result has no preview to show; the original file still
    // uploads via the untouched `dataUrl`.
    if (!jpegBlob) return null;
    return await blobToDataUrl(jpegBlob);
  } catch {
    return null;
  }
}
