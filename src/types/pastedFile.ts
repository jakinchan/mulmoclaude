// Pasted/dropped chat attachment carried from ChatInput up to the
// send pipeline. Lives outside ChatInput.vue so non-Vue modules
// (e.g. utils/agent/pastedAttachment.ts) can import it under the
// test tsconfig, which sees `*.vue` only as the ambient shim.

export interface PastedFile {
  /** Base64 `data:` URL of the ORIGINAL file bytes, used verbatim by
   *  the upload pipeline. Never mutated after pick — the server-side
   *  conversion (HEIC → JPEG, PPTX → PDF, …) works off these bytes. */
  dataUrl: string;
  name: string;
  mime: string;
  /** Browser-decoded JPEG data URL used ONLY for the pre-send
   *  `<img>` preview when the browser can't render `mime` natively
   *  (Chrome refuses HEIC / HEIF). Undefined when either the browser
   *  can render `mime` directly or when the conversion failed — the
   *  preview component falls back to a file-icon chip in that case.
   *  The upload pipeline never reads this field. */
  previewDataUrl?: string | undefined;
}
