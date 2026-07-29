// Read / overwrite files the TOOL CALL named, rather than files the app minted.
// `presentDocument(path)` / `presentHtml(path)` open a document that already
// exists — a repo's `README.md`, `docs/report.html`, an absolute path — and the
// user's edits in the view overwrite it in place.
//
// Shared by both hosts (MulmoClaude's `server/utils/files/by-path.ts` and
// MulmoTerminal's backend bind their own workspace root to it), because the
// judgement of what a `path` argument may reach is exactly the thing that must
// not drift between them: a host that accepts what the other refuses turns one
// tool call into two different behaviours.
//
// The rules:
//   - `classifyFilePath` (also what the plugins' `path` gate calls) decides the
//     shape: right extension, no NUL, no `.` / `..` / empty segment. That
//     lexical guard is what stops a vetted path from being re-pointed later.
//   - relative paths resolve against the injected root; absolute paths are taken
//     as given. There is deliberately NO containment check — opening a file
//     outside the workspace is the documented purpose of the `path` form. The
//     agent can already read and write those files directly; what is new is that
//     the view can too.
//   - a value that is absolute only under ANOTHER platform's rules is refused:
//     `classifyFilePath` recognises `C:\proj\x.md` everywhere (the value may
//     come from a remote host), but on POSIX `path.resolve("C:/proj/x.md")`
//     lands under the process cwd — a file nobody named.
//   - reads and writes require a REGULAR FILE, judged through `realpath` so a
//     symlink is assessed by what it points at and a directory named `x.md`
//     cannot masquerade as a document.
//   - `write` overwrites only. Neither tool creates a file at a caller-supplied
//     path, so a write to a path that does not exist means the view is stale or
//     the path was wrong — refusing keeps a typo from scattering files.
//   - `readDir` and `unlink` are refused outright: this capability exists to
//     read and re-save ONE named document, not to browse or delete.

import { readFile, realpath, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { classifyFilePath } from "../artifacts/paths.js";
import { writeFileAtomic } from "./atomic.js";

export const MARKDOWN_EXTENSIONS = [".md"] as const;
export const HTML_EXTENSIONS = [".html", ".htm"] as const;

/** Minimal structural echo of gui-chat-protocol's `FileOps`. Declared here
 *  rather than imported so core keeps no dependency on the protocol package;
 *  a host assigns the result straight to a `FileOps`-typed capability. */
export interface ByPathFileOps {
  read: (rel: string) => Promise<string>;
  readBytes: (rel: string) => Promise<Uint8Array>;
  write: (rel: string, content: string | Uint8Array) => Promise<void>;
  readDir: (rel: string) => Promise<string[]>;
  stat: (rel: string) => Promise<{ mtimeMs: number; size: number }>;
  exists: (rel: string) => Promise<boolean>;
  unlink: (rel: string) => Promise<void>;
}

/** Absolute on-disk path for a caller-supplied path with one of `extensions`,
 *  or null when the value is not usable on this platform. */
export function resolveByPath(root: string, value: string, extensions: readonly string[]): string | null {
  const kind = classifyFilePath(value, extensions);
  if (kind === null) return null;
  if (kind === "relative") return path.resolve(root, value);
  return path.isAbsolute(value) ? path.resolve(value) : null;
}

/** True when the path names an existing regular file. */
export async function existsAsFile(root: string, value: string, extensions: readonly string[]): Promise<boolean> {
  const absPath = resolveByPath(root, value, extensions);
  return absPath === null ? false : (await regularFileTarget(absPath)) !== null;
}

export interface ByPathOptions {
  /** The root relative values resolve against, read PER CALL — hosts inject the
   *  workspace after these ops are already bound into plugin closures. */
  rootFor: () => string;
  extensions: readonly string[];
}

function resolveOrThrow({ rootFor, extensions }: ByPathOptions, value: string): string {
  const absPath = resolveByPath(rootFor(), value, extensions);
  if (absPath === null) throw new Error(`invalid path: ${value}`);
  return absPath;
}

/** The canonical REGULAR FILE a path names, or null when it is missing, is a
 *  directory, or is anything else (a FIFO would block a read forever).
 *  Resolved through `realpath` so a symlink is judged — and later written — by
 *  what it points at: `writeFileAtomic` renames a temp file into place, which
 *  through a link would replace the link itself and leave the real document
 *  untouched. */
async function regularFileTarget(absPath: string): Promise<string | null> {
  try {
    const target = await realpath(absPath);
    return (await fsStat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

/** The file to read or overwrite. Throws rather than creating: neither tool
 *  ever writes to a path that does not already hold a document. */
async function existingFileFor(options: ByPathOptions, rel: string): Promise<string> {
  const target = await regularFileTarget(resolveOrThrow(options, rel));
  if (target === null) throw new Error(`no file exists at ${rel}`);
  return target;
}

/** Browsing and deleting are NOT part of this capability: it exists so a view
 *  can read and re-save the ONE document the tool call named, not to enumerate
 *  a directory it was never pointed at or remove a file. */
function unsupported(operation: string): () => Promise<never> {
  return () => Promise.reject(new Error(`byPath FileOps does not support ${operation}`));
}

/** FileOps over caller-supplied paths — what a host injects as `files.byPath`
 *  for plugins whose `path` argument may leave their artifact directory. Every
 *  method takes the same value the tool call carried, not a scope-relative one. */
export function createByPathFileOps(options: ByPathOptions): ByPathFileOps {
  return {
    read: async (rel) => readFile(await existingFileFor(options, rel), "utf-8"),
    readBytes: async (rel) => {
      const buf = await readFile(await existingFileFor(options, rel));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    write: async (rel, content) => writeFileAtomic(await existingFileFor(options, rel), content),
    readDir: unsupported("readDir"),
    stat: async (rel) => {
      const { mtimeMs, size } = await fsStat(resolveOrThrow(options, rel));
      return { mtimeMs, size };
    },
    exists: (rel) => existsAsFile(options.rootFor(), rel, options.extensions),
    unlink: unsupported("unlink"),
  };
}
