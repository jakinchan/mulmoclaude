import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A temp directory that removes itself when the test process exits.
//
// `tsx --test` runs one process per test file, so a single exit hook collects
// everything the file made — module scope, before(), or inside a test — without
// each call site having to remember a teardown. Tests that skipped that teardown
// leaked ~208 directories per full-suite run into $TMPDIR (#2789).
//
// Exit hooks can only do synchronous work, which is why removal is rmSync.
const created: string[] = [];
let hookInstalled = false;

const installExitHook = () => {
  if (hookInstalled) return;
  hookInstalled = true;
  process.once("exit", () => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
};

export const makeTempDir = (prefix: string): string => {
  installExitHook();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
