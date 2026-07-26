// MulmoClaude's host wiring for the presentHtml plugin's dispatch channel.
// The extracted @mulmoclaude/html-plugin View reaches host storage through
// `useRuntime().dispatch({ kind: "loadHtml" | "saveHtml", … })`; this registers
// the built-in "html" dispatch handler that routes those calls to the package's
// `executeHtmlDispatch` against the GENERIC `files.artifacts` capability, then
// publishes a file-change event after a save so subscribed View tabs refresh.
// Imported for side effect at boot (server/index.ts) so the dispatch resolves.

import { executeHtmlDispatch, isHtmlDispatchArgs, isPackHtmlArgs } from "@mulmoclaude/html-plugin";
import type { PackHtmlArgs, PackHtmlResult } from "@mulmoclaude/html-plugin";
import { makeArtifactsFileOps } from "./runtime.js";
import { publishFileChange } from "../events/file-change.js";
import { describeKind, registerBuiltinDispatch } from "./builtin-dispatch.js";
import { packHtmlZip } from "../utils/share/packHtml.js";
import { isHtmlPath } from "../utils/files/html-store.js";

/** Scope name — matches `wrapWithScope("html", …)` in
 *  `src/plugins/presentHtml/index.ts`, which is what the View's
 *  `useRuntime().dispatch` uses as the `:pkg` path segment. */
const HTML_SCOPE = "html";

// `packHtml` bundles the page + its local assets into a self-contained
// zip. It lives host-side (binary reads + zip via server/utils/share),
// so it's intercepted here rather than in the package's pure router.
async function packHtmlForDownload(args: PackHtmlArgs): Promise<PackHtmlResult> {
  if (!isHtmlPath(args.path)) throw new Error("path must be a canonical artifacts/html/*.html file");
  const { filename, zip } = await packHtmlZip(args.path);
  return { filename, zipBase64: zip.toString("base64") };
}

// `args` is whatever the View put on the wire — untyped data, not a value the
// compiler has vouched for. The package exports guards for its own shapes, so
// the boundary narrows instead of asserting.
registerBuiltinDispatch(HTML_SCOPE, async (args) => {
  if (isPackHtmlArgs(args)) {
    return packHtmlForDownload(args);
  }
  if (!isHtmlDispatchArgs(args)) {
    throw new Error(`html plugin: unrecognised dispatch payload (kind=${describeKind(args)})`);
  }
  const dispatchArgs = args;
  const result = await executeHtmlDispatch({ files: { artifacts: makeArtifactsFileOps() } }, dispatchArgs);
  // saveHtml changed bytes on disk → nudge subscribed View tabs (load is read-only).
  if (dispatchArgs.kind === "saveHtml") {
    void publishFileChange(dispatchArgs.path);
  }
  return result;
});
