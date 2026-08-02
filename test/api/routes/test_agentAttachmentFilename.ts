// The original filename has to survive the whole server-side walk to
// reach the model (#2308). Two hops drop it if nobody is watching:
//
//   1. `prepareRequestExtras` rebuilds each attachment as an
//      `AttachedFile` for the marker layer — a plain `{ path }` there
//      silently loses the name for every upload.
//   2. `persistInlineBytesAsPaths` rewrites a bridge's inline bytes
//      into a stored path. Telegram already sends `doc.file_name`, so
//      this hop is where a name that DID arrive used to disappear.
//
// Hop 2 isn't exported, so it's covered through `startChat` in the
// route tests; here we pin hop 1 plus the end-to-end marker text,
// which is what the model actually sees.
//
// Needs a real file on disk: `prepareRequestExtras` only emits an
// entry once `loadFromPath` succeeds, so a fixture-less test would
// pass for the wrong reason.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Attachment } from "@mulmobridge/protocol";

let workspaceRoot: string;
let originalHome: string | undefined;
let prepareRequestExtras: typeof import("../../../server/api/routes/agent.ts").prepareRequestExtras;
let withAttachedFileMarker: typeof import("../../../server/agent/messageDecorate.ts").withAttachedFileMarker;

const PARTITION = "2026/07";
const STORED_NAME = "b458a5d02a184ac2.csv";
const STORED_PATH = `data/attachments/${PARTITION}/${STORED_NAME}`;
const ORIGINAL_NAME = "商品カタログ_v2.csv";

before(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "mulmoclaude-attachment-filename-"));
  originalHome = process.env.HOME;
  process.env.HOME = workspaceRoot;
  process.env.MULMOCLAUDE_WORKSPACE_PATH = workspaceRoot;

  const attachmentsDir = path.join(workspaceRoot, "data", "attachments", ...PARTITION.split("/"));
  await mkdir(attachmentsDir, { recursive: true });
  await writeFile(path.join(attachmentsDir, STORED_NAME), "sku,price\nA-1,980\n", "utf-8");

  ({ prepareRequestExtras } = await import("../../../server/api/routes/agent.ts"));
  ({ withAttachedFileMarker } = await import("../../../server/agent/messageDecorate.ts"));
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.MULMOCLAUDE_WORKSPACE_PATH;
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
});

describe("prepareRequestExtras — original filename (#2308)", () => {
  it("carries the original filename onto the attached-file entry", async () => {
    const attachments: Attachment[] = [{ path: STORED_PATH, filename: ORIGINAL_NAME }];
    const out = await prepareRequestExtras(attachments);
    assert.deepEqual(out.attachedFiles, [{ path: STORED_PATH, filename: ORIGINAL_NAME }]);
  });

  it("omits the key entirely when the attachment carries no filename", async () => {
    const out = await prepareRequestExtras([{ path: STORED_PATH }]);
    assert.deepEqual(out.attachedFiles, [{ path: STORED_PATH }]);
  });

  it("omits the key for an empty-string filename rather than announcing a blank name", async () => {
    const out = await prepareRequestExtras([{ path: STORED_PATH, filename: "" }]);
    assert.deepEqual(out.attachedFiles, [{ path: STORED_PATH }]);
  });

  it("still loads the bytes for the model alongside the name", async () => {
    const out = await prepareRequestExtras([{ path: STORED_PATH, filename: ORIGINAL_NAME }]);
    assert.equal(out.attachments?.length, 1);
    const attachment = out.attachments?.[0];
    assert.ok(attachment);
    assert.equal(attachment.mimeType, "text/csv");
    assert.ok(attachment.data, "bytes should be loaded off disk");
  });

  it("produces the marker line the model reads, end to end", async () => {
    const out = await prepareRequestExtras([{ path: STORED_PATH, filename: ORIGINAL_NAME }]);
    assert.equal(
      withAttachedFileMarker("これ要約して", out.attachedFiles),
      `[Attached file: ${STORED_PATH} (original name: ${ORIGINAL_NAME})]\n\nこれ要約して`,
    );
  });
});
