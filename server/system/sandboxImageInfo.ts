// What the sandbox image is, read off its own labels — pure parsing, no
// `docker` calls (those live in `docker.ts`).
//
// Why this exists: the image is rebuilt only when `Dockerfile.sandbox`'s sha
// changes, so the Claude CLI baked into it is frozen for as long as that file
// stays put. #2842 was reported by someone who had to work out the CLI version
// by grepping the bundle inside their own image, because nothing on our side
// ever said which one was in play. Recording it at build time as a label makes
// it a one-line answer at boot instead.

import { ONE_DAY_MS } from "../utils/time.js";

export const DOCKERFILE_SHA_LABEL = "mulmoclaude.dockerfile.sha256";
export const CLAUDE_CODE_LABEL = "mulmoclaude.claude-code.version";

/** The floor our MCP config depends on: `alwaysLoad` (server/agent/config.ts)
 *  is read by CLI 2.1.121 and newer. An older CLI silently ignores it and
 *  keeps the ~5 s connect wait the field is there to escape (#2201, #2234). */
export const MIN_CLAUDE_CODE_VERSION = "2.1.121";

/** Past this the CLI in the image is far enough behind npm that a user hitting
 *  a CLI-side bug is likely chasing one already fixed upstream. A warn, never a
 *  forced rebuild: rebuilding costs minutes (LibreOffice layers) and is the
 *  user's call to make. */
export const SANDBOX_IMAGE_STALE_DAYS = 30;

/** Single `docker image inspect --format` template covering everything we read.
 *  One call, three answers — the sha check was already paying for it. */
export const IMAGE_INSPECT_FORMAT = `{{index .Config.Labels "${DOCKERFILE_SHA_LABEL}"}}|{{index .Config.Labels "${CLAUDE_CODE_LABEL}"}}|{{.Created}}`;

export interface SandboxImageInfo {
  dockerfileSha: string;
  /** `null` when the image predates the label, or was built without npm
   *  reachable so the version could not be resolved. */
  claudeCodeVersion: string | null;
  /** `null` when `.Created` was missing or unparsable. */
  ageDays: number | null;
}

// Go templates print this for a map key that isn't there, and a build that
// could not resolve npm's latest passes the literal `latest` — neither names
// a version, so both mean "not recorded".
const ABSENT_LABEL_VALUES: ReadonlySet<string> = new Set(["", "<no value>", "latest"]);

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

function parseSemver(raw: string): [number, number, number] | null {
  const match = SEMVER_PATTERN.exec(raw.trim());
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return [Number(major), Number(minor), Number(patch)];
}

/** `null` when either side isn't a parsable version. The caller must not fold
 *  "can't tell" into "too old" — a warn that fires on every boot for an
 *  unknowable reason is noise the reader learns to skip. */
export function isAtLeastVersion(version: string, minimum: string): boolean | null {
  const left = parseSemver(version);
  const right = parseSemver(minimum);
  if (left === null || right === null) return null;
  const [leftMajor, leftMinor, leftPatch] = left;
  const [rightMajor, rightMinor, rightPatch] = right;
  if (leftMajor !== rightMajor) return leftMajor > rightMajor;
  if (leftMinor !== rightMinor) return leftMinor > rightMinor;
  return leftPatch >= rightPatch;
}

function labelOrNull(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  return ABSENT_LABEL_VALUES.has(value) ? null : value;
}

function ageDaysFrom(created: string | undefined, nowMs: number): number | null {
  const createdMs = Date.parse(created?.trim() ?? "");
  if (Number.isNaN(createdMs)) return null;
  return Math.floor((nowMs - createdMs) / ONE_DAY_MS);
}

/** Parse one `docker image inspect --format IMAGE_INSPECT_FORMAT` line. */
export function parseSandboxImageInfo(stdout: string, nowMs: number): SandboxImageInfo {
  const [sha, version, created] = stdout.trim().split("|");
  return {
    dockerfileSha: labelOrNull(sha) ?? "",
    claudeCodeVersion: labelOrNull(version),
    ageDays: ageDaysFrom(created, nowMs),
  };
}

export interface SandboxImageWarning {
  message: string;
  data: Record<string, unknown>;
}

const REFRESH_HINT = "force a refresh with `docker rmi mulmoclaude-sandbox` and restart — the next boot rebuilds with npm's current CLI";

/** Every reason to nudge the user about this image, as data the caller logs.
 *  Returned rather than logged so the rules stay testable without a log spy. */
export function sandboxImageWarnings(info: SandboxImageInfo): SandboxImageWarning[] {
  const warnings: SandboxImageWarning[] = [];
  const { claudeCodeVersion, ageDays } = info;
  if (claudeCodeVersion !== null && isAtLeastVersion(claudeCodeVersion, MIN_CLAUDE_CODE_VERSION) === false) {
    warnings.push({
      message: "Claude CLI in the sandbox image is older than the version our MCP config needs",
      data: {
        claudeCodeVersion,
        required: MIN_CLAUDE_CODE_VERSION,
        effect: "`alwaysLoad` is ignored, so the broker gets only the CLI's short default connect wait",
        fix: REFRESH_HINT,
      },
    });
  }
  if (ageDays !== null && ageDays >= SANDBOX_IMAGE_STALE_DAYS) {
    warnings.push({
      message: "sandbox image is stale — its Claude CLI is frozen at build time and only a rebuild moves it",
      data: { ageDays, staleAfterDays: SANDBOX_IMAGE_STALE_DAYS, fix: REFRESH_HINT },
    });
  }
  return warnings;
}
