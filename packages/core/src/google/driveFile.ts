// Google Drive v3 REST calls under the `drive.file` scope — the app only
// ever sees files IT created, never the user's wider Drive. That narrow
// scope is why this is non-sensitive and needs no Google verification
// review; keep every call inside it.
import { randomBytes } from "node:crypto";
import { asRecord, googleRequest, stringField, DEFAULT_LIST_MAX_RESULTS } from "./apiClient.js";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_API_LABEL = "Google Drive API";
const DEFAULT_MIME_TYPE = "text/plain";
const FILE_FIELDS = "id,name,mimeType,webViewLink,modifiedTime";
// Reading a huge blob into a tool result would blow the context window; the
// tool surface is for app-created text documents, not media.
const MAX_READ_CHARS = 100_000;
const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/javascript"];

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  modifiedTime: string;
}

export interface ListDriveFilesInput {
  maxResults?: number | undefined;
}

export interface CreateDriveFileInput {
  name: string;
  content: string;
  mimeType?: string | undefined;
}

export interface ReadDriveFileInput {
  fileId: string;
}

export const toDriveFileSummary = (value: unknown): DriveFileSummary => {
  const record = asRecord(value);
  return {
    id: stringField(record, "id"),
    name: stringField(record, "name"),
    mimeType: stringField(record, "mimeType"),
    webViewLink: stringField(record, "webViewLink"),
    modifiedTime: stringField(record, "modifiedTime"),
  };
};

export const isTextMimeType = (mimeType: string): boolean => TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));

export async function listDriveFiles(accessToken: string, input: ListDriveFilesInput = {}): Promise<DriveFileSummary[]> {
  const params = new URLSearchParams({
    pageSize: String(input.maxResults ?? DEFAULT_LIST_MAX_RESULTS),
    fields: `files(${FILE_FIELDS})`,
    orderBy: "modifiedTime desc",
  });
  const listed = await googleRequest(DRIVE_API_LABEL, accessToken, `${DRIVE_FILES_URL}?${params.toString()}`);
  const record = asRecord(listed);
  const files = Array.isArray(record.files) ? record.files : [];
  return files.map(toDriveFileSummary);
}

// Multipart upload: metadata part + media part in one request. Built by hand
// because the `googleapis` SDK is the only alternative and this is the sole
// multipart call in the engine.
const BOUNDARY_BYTES = 16;

/** Fresh per request: a fixed boundary appearing inside file content would
 *  split the payload at the wrong place, so Drive would store a truncated or
 *  mangled file. Random 128 bits makes an accidental — or crafted — collision
 *  infeasible; `newMultipartBoundary` is re-derived until it is absent from
 *  the body it must delimit. */
const newMultipartBoundary = (): string => `mulmo-drive-${randomBytes(BOUNDARY_BYTES).toString("hex")}`;

// RFC 2045 token + parameters: no CR/LF (header injection into the part
// headers) and no quotes/semicolons that would let a crafted value forge
// extra headers or parameters.
const MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

export const assertSafeMimeType = (mimeType: string): string => {
  if (!MIME_TYPE_RE.test(mimeType)) throw new Error(`Google Drive API: invalid mimeType '${mimeType}' — expected a plain type/subtype such as text/plain`);
  return mimeType;
};

export const buildMultipartBody = (metadata: Record<string, string>, content: string, mimeType: string, boundary: string): string =>
  [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");

/** A boundary that appears nowhere in the parts it delimits. */
export const pickBoundary = (parts: string[], generate: () => string = newMultipartBoundary): string => {
  const collides = (candidate: string): boolean => parts.some((part) => part.includes(candidate));
  let boundary = generate();
  while (collides(boundary)) boundary = generate();
  return boundary;
};

export async function createDriveFile(accessToken: string, input: CreateDriveFileInput): Promise<DriveFileSummary> {
  const mimeType = assertSafeMimeType(input.mimeType ?? DEFAULT_MIME_TYPE);
  const metadata = { name: input.name, mimeType };
  const boundary = pickBoundary([input.content, JSON.stringify(metadata)]);
  const params = new URLSearchParams({ uploadType: "multipart", fields: FILE_FIELDS });
  const created = await googleRequest(DRIVE_API_LABEL, accessToken, `${DRIVE_UPLOAD_URL}?${params.toString()}`, {
    method: "POST",
    contentType: `multipart/related; boundary=${boundary}`,
    body: buildMultipartBody(metadata, input.content, mimeType, boundary),
  });
  return toDriveFileSummary(created);
}

export async function readDriveFile(accessToken: string, input: ReadDriveFileInput): Promise<{ file: DriveFileSummary; content: string }> {
  const fileId = encodeURIComponent(input.fileId);
  const metadata = await googleRequest(DRIVE_API_LABEL, accessToken, `${DRIVE_FILES_URL}/${fileId}?fields=${FILE_FIELDS}`);
  const file = toDriveFileSummary(metadata);
  if (!isTextMimeType(file.mimeType)) {
    throw new Error(`Google Drive API: '${file.name}' is ${file.mimeType || "a binary file"} — only text files can be read as content`);
  }
  const raw = await googleRequest(DRIVE_API_LABEL, accessToken, `${DRIVE_FILES_URL}/${fileId}?alt=media`, { expectText: true });
  const content = typeof raw === "string" ? raw.slice(0, MAX_READ_CHARS) : "";
  return { file, content };
}

export async function deleteDriveFile(accessToken: string, input: ReadDriveFileInput): Promise<void> {
  await googleRequest(DRIVE_API_LABEL, accessToken, `${DRIVE_FILES_URL}/${encodeURIComponent(input.fileId)}`, { method: "DELETE" });
}
