// Resolution + a generic `FileOps` for files the TOOL CALL named, rather than
// files this app minted. `presentDocument(path)` / `presentHtml(path)` open a
// document that already exists — a repo's `README.md`, `docs/report.html`, an
// absolute path — and the user's edits in the view overwrite it in place.
//
// The rules, in one place so the markdown and html sides cannot drift:
//   - `classifyFilePath` (shared with the plugins) decides the shape: right
//     extension, no NUL, no `.` / `..` / empty segment. That lexical guard is
//     what stops a vetted path from being re-pointed afterwards.
//   - relative paths resolve against the workspace; absolute paths are taken as
//     given. There is deliberately NO containment check: opening a file outside
//     the workspace is the documented purpose. The agent could already read and
//     write those files directly; what is new is that the view can too.
//   - `write` overwrites only. These tools never create a file at a
//     caller-supplied path, so a write to a path that does not exist means the
//     view is stale or the path was wrong — refusing keeps a typo from
//     scattering files across the disk.

import { readFile, realpath, readdir, stat as fsStat, unlink as fsUnlink } from "fs/promises";
import path from "path";
import type { FileOps } from "gui-chat-protocol";
import { classifyFilePath } from "@mulmoclaude/core/artifacts";
import { workspacePath } from "../../workspace/workspace.js";
import { writeFileAtomic } from "./atomic.js";
import { isErrorWithCode } from "../types.js";

/** Absolute on-disk path for a caller-supplied path with one of `extensions`,
 *  or null when the value is not usable. Relative values resolve against the
 *  workspace root; absolute ones are returned normalised. */
export function resolveByPath(value: string, extensions: readonly string[]): string | null {
  const kind = classifyFilePath(value, extensions);
  if (kind === null) return null;
  return kind === "absolute" ? path.resolve(value) : path.resolve(workspacePath, value);
}

function resolveOrThrow(value: string, extensions: readonly string[]): string {
  const absPath = resolveByPath(value, extensions);
  if (absPath === null) throw new Error(`invalid path: ${value}`);
  return absPath;
}

/** True when the path names an existing regular file. Resolved through
 *  `realpath` first so a symlink is judged by what it points AT, and
 *  `isFile()` so a directory named `report.md` is not mistaken for one. */
export async function existsAsFile(value: string, extensions: readonly string[]): Promise<boolean> {
  const absPath = resolveByPath(value, extensions);
  if (absPath === null) return false;
  try {
    return (await fsStat(await realpath(absPath))).isFile();
  } catch {
    return false;
  }
}

/**
 * `FileOps` over caller-supplied paths — what a host injects as
 * `files.byPath` for plugins whose `path` argument may leave their artifact
 * directory. Every method takes the same workspace-relative-or-absolute value
 * the tool call carried, not a scope-relative one.
 */
export function makeByPathFileOps(extensions: readonly string[]): FileOps {
  return {
    async read(rel) {
      return readFile(resolveOrThrow(rel, extensions), "utf-8");
    },
    async readBytes(rel) {
      const buf = await readFile(resolveOrThrow(rel, extensions));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async write(rel, content) {
      const absPath = resolveOrThrow(rel, extensions);
      if (!(await existsAsFile(rel, extensions))) throw new Error(`no file exists at ${rel}`);
      await writeFileAtomic(absPath, content);
    },
    async readDir(rel) {
      try {
        return await readdir(resolveOrThrow(rel, extensions));
      } catch (err) {
        if (isErrorWithCode(err) && err.code === "ENOENT") return [];
        throw err;
      }
    },
    async stat(rel) {
      const { mtimeMs, size } = await fsStat(resolveOrThrow(rel, extensions));
      return { mtimeMs, size };
    },
    async exists(rel) {
      return existsAsFile(rel, extensions);
    },
    async unlink(rel) {
      try {
        await fsUnlink(resolveOrThrow(rel, extensions));
      } catch (err) {
        if (isErrorWithCode(err) && err.code === "ENOENT") return;
        throw err;
      }
    },
  };
}
