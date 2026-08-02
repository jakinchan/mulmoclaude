// Domain IO for `config/csp.json` — the user's optional CSP extension for
// sandboxed HTML views (#1989). Per-directive extra hosts are ADDED to the
// hardcoded base policy. Read is sync + validating: both consumers (the
// /artifacts/html header in server/index.ts and the /api/config response)
// run in sync contexts and want live edits picked up per request. A missing /
// unreadable / malformed file reads as `{}` (no extension) — never throws.

import path from "node:path";
import { WORKSPACE_FILES, workspacePath } from "../../workspace/paths.js";
import { readTextSafeSync } from "./safe.js";
import { sanitizeCspExtra, type CspExtraHosts } from "../../../src/utils/html/previewCsp.js";
import { log } from "../../system/logger/index.js";

function cspFilePath(workspaceRoot?: string): string {
  return path.join(workspaceRoot ?? workspacePath, WORKSPACE_FILES.csp);
}

export function readCspExtraSync(workspaceRoot?: string): CspExtraHosts {
  const text = readTextSafeSync(cspFilePath(workspaceRoot));
  if (text === null) return {};
  try {
    return sanitizeCspExtra(JSON.parse(text));
  } catch {
    return {};
  }
}

// Log a boot-time warning when the user has extended the sandbox CSP, so the
// added attack surface is never silent. `connect-src` gets a distinct, louder
// warning — it's the one that opens a two-way exfiltration channel for a
// custom view's scoped token/data (#1989).
export function warnIfCspExtended(workspaceRoot?: string): void {
  const extra = readCspExtraSync(workspaceRoot);
  const directives = Object.entries(extra);
  if (directives.length === 0) return;
  const summary = directives.map(([directive, hosts]) => `${directive}=[${(hosts ?? []).join(", ")}]`).join(" ");
  log.warn("csp", `config/csp.json extends the sandbox CSP; every added host is a supply-chain / exfiltration surface: ${summary}`);
  const connectHosts = extra["connect-src"] ?? [];
  if (connectHosts.length > 0) {
    log.warn(
      "csp",
      `config/csp.json widens connect-src to [${connectHosts.join(", ")}] — a custom view can now send its scoped token/data to these hosts (two-way exfiltration). Keep ONLY hosts you fully trust.`,
    );
  }
}
