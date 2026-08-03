import type { FileOps } from "gui-chat-protocol";
import type { MulmoScript } from "@mulmocast/types";

/** Tool-call arguments for presentMulmoScript. `script` (create new) and
 *  `filePath` (reopen existing) are mutually exclusive — provide exactly one.
 *  `filename` only applies to the create path; `autoGenerateMovie` is handled
 *  by hosts that have a movie backend (the package core ignores it). */
export interface SaveMulmoScriptArgs {
  script?: unknown;
  filename?: string | undefined;
  filePath?: string | undefined;
  autoGenerateMovie?: boolean | undefined;
}

/** Result payload that drives the View. `filePath` is the historical
 *  `stories/<name>.json` wire form every mulmoScript endpoint keys on. */
export interface MulmoScriptData {
  script: MulmoScript;
  filePath: string;
}

/** Host capabilities the phase-1 core needs, delivered through the GENERIC
 *  gui-chat-protocol runtime — only `files.artifacts` (the shared,
 *  user-browsable output area rooted at `<workspace>/artifacts`). Save /
 *  reopen / update logic lives entirely in this package; heavy render
 *  backends (mulmocast, ffmpeg) stay host-side until phase 3. */
export interface MulmoScriptExecuteContext {
  files: { artifacts: FileOps };
}
