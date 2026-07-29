// `resolveByPath` — the host's half of presentDocument / presentHtml's `path`
// argument. The plugins' `classifyFilePath` says whether a value is SHAPED like
// a usable path; this says where it actually lands, which is the only place the
// current platform's rules apply.
//
// The workspace is redirected via HOME before the module is imported, matching
// the route tests' harness.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

type ByPathModule = typeof import("../../../server/utils/files/by-path.js");

const MARKDOWN = [".md"] as const;

let tmpRoot: string;
let workspaceDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let resolveByPath: ByPathModule["resolveByPath"];

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "mulmo-by-path-"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;

  const { workspacePath } = await import("../../../server/workspace/workspace.js");
  workspaceDir = workspacePath;
  ({ resolveByPath } = await import("../../../server/utils/files/by-path.js"));
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("resolveByPath", () => {
  it("resolves a relative path against the workspace", () => {
    assert.equal(resolveByPath("docs/design.md", MARKDOWN), path.join(workspaceDir, "docs/design.md"));
  });

  it("takes an absolute path as given", () => {
    assert.equal(resolveByPath("/Users/x/project/README.md", MARKDOWN), path.resolve("/Users/x/project/README.md"));
  });

  it("refuses the wrong extension, traversal and non-canonical segments", () => {
    assert.equal(resolveByPath("docs/design.txt", MARKDOWN), null);
    assert.equal(resolveByPath("../secret.md", MARKDOWN), null);
    assert.equal(resolveByPath("docs/../../secret.md", MARKDOWN), null);
    assert.equal(resolveByPath("/etc/../etc/passwd.md", MARKDOWN), null);
    assert.equal(resolveByPath("docs/./design.md", MARKDOWN), null);
    assert.equal(resolveByPath("docs//design.md", MARKDOWN), null);
    assert.equal(resolveByPath("", MARKDOWN), null);
    assert.equal(resolveByPath("docs/a\0.md", MARKDOWN), null);
  });

  // `classifyFilePath` recognises `C:\proj\x.md` on every platform, because the
  // value can arrive from a remote host. Resolving it HERE is a different
  // question: on POSIX, `path.resolve("C:/proj/x.md")` lands under the process
  // cwd, so accepting it would read and overwrite a file nobody named.
  it("refuses a Windows-drive path on a POSIX host", { skip: process.platform === "win32" }, () => {
    assert.equal(resolveByPath("C:/proj/notes.md", MARKDOWN), null);
    assert.equal(resolveByPath("C:\\proj\\notes.md", MARKDOWN), null);
  });

  // A single leading backslash is Windows ROOT-RELATIVE: `path.resolve` sends it
  // to the drive root there, so classifying it as workspace-relative would have
  // the shape check and the resolution disagree about where the file is.
  it("refuses a Windows root-relative path on a POSIX host", { skip: process.platform === "win32" }, () => {
    assert.equal(resolveByPath("\\dir\\notes.md", MARKDOWN), null);
  });
});
