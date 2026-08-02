// Shared browser blob-download helpers used by the share composables
// (useSharePack, useMarkdownZip). Keeps the createObjectURL → click →
// revoke dance and the Content-Disposition filename parsing in one place.

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Defer revocation to the next task: revoking synchronously right after
  // click() can cancel the download in some browsers before the blob is read.
  setTimeout(() => URL.revokeObjectURL(url));
}

const DISPOSITION_FILENAME_RE = /filename="?([^";]+)"?/;

export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  return DISPOSITION_FILENAME_RE.exec(header)?.[1] ?? fallback;
}
