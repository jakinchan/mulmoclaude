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

import { readFile, realpath, readdir, stat as fsStat, unlink as fsUnlink } from "node:fs/promises";
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
  if (absPath === null) return false;
  try {
    return (await fsStat(await realpath(absPath))).isFile();
  } catch {
    return false;
  }
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

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/** FileOps over caller-supplied paths — what a host injects as `files.byPath`
 *  for plugins whose `path` argument may leave their artifact directory. Every
 *  method takes the same value the tool call carried, not a scope-relative one. */
export function createByPathFileOps(options: ByPathOptions): ByPathFileOps {
  const exists = (value: string) => existsAsFile(options.rootFor(), value, options.extensions);
  return {
    async read(rel) {
      return readFile(resolveOrThrow(options, rel), "utf-8");
    },
    async readBytes(rel) {
      const buf = await readFile(resolveOrThrow(options, rel));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async write(rel, content) {
      const absPath = resolveOrThrow(options, rel);
      if (!(await exists(rel))) throw new Error(`no file exists at ${rel}`);
      await writeFileAtomic(absPath, content);
    },
    async readDir(rel) {
      try {
        return await readdir(resolveOrThrow(options, rel));
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
    },
    async stat(rel) {
      const { mtimeMs, size } = await fsStat(resolveOrThrow(options, rel));
      return { mtimeMs, size };
    },
    async exists(rel) {
      return exists(rel);
    },
    async unlink(rel) {
      try {
        await fsUnlink(resolveOrThrow(options, rel));
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    },
  };
}
