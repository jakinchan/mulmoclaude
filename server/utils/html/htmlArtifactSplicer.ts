// Read an HTML artifact file under the `/artifacts/html` static
// mount and splice two helper scripts before its closing `</body>`:
//   1. The image-self-repair script (#1011 Stage E / #1025) — restores
//      the behavior that PR #980 unhooked when presentHtml / Files
//      HTML preview moved off `srcdoc` onto the static mount.
//   2. The iframe height reporter (#1219 follow-up) — lets the parent
//      StackView size the iframe to its rendered content despite the
//      `sandbox="allow-scripts"` cross-origin barrier.
//
// Both scripts are pure string injections of trusted server code; the
// helpers are pure functions and order doesn't matter (one-shot scripts
// that observe their own document state).
//
// Lives in its own module — not inline in `server/index.ts` — so unit
// tests can import the helpers without dragging the entire server
// startup as an import side effect.

import { readFile as fsReadFile } from "fs/promises";
import { resolveWithinRoot } from "../files/safe.js";
import { injectImageRepairScript } from "../../../src/utils/image/imageRepairInlineScript.js";
import { injectHeightReporterScript } from "../../../src/utils/html/iframeHeightReporterScript.js";

/** Read an HTML artifact file (under `htmlsRoot`) and splice the
 *  image-self-repair script before its closing `</body>`. Returns
 *  the spliced HTML on success, `null` when the file can't be
 *  resolved (escapes the root) or read (missing / unreadable).
 *
 *  `htmlsRoot` MUST already be a realpath — `resolveWithinRoot`
 *  compares against it strictly. The middleware in `server/index.ts`
 *  passes the cached `getHtmlsDirReal()` result, which is a realpath. */
export async function readAndInjectHtmlArtifact(htmlsRoot: string, relPath: string): Promise<string | null> {
  const abs = resolveWithinRoot(htmlsRoot, relPath);
  if (!abs) return null;
  return readAndInjectHtmlFile(abs);
}

/** Same splice, for a page the caller has ALREADY resolved to an absolute path.
 *  The `/htmlfile` mount serves pages outside `artifacts/html/` (presentHtml's
 *  `path` form), so there is no root to contain them to — its own resolver
 *  (`htmlFileRequest.ts`) is what vets the request before this point. */
export async function readAndInjectHtmlFile(absPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fsReadFile(absPath, "utf8");
  } catch {
    return null;
  }
  return injectHeightReporterScript(injectImageRepairScript(raw));
}
