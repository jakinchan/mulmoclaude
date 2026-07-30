// Resolution helpers for the Claude Code CLI's on-disk config locations.
//
// Why this exists: six call sites used to hardcode `homedir() + ".claude"` and
// `homedir() + ".claude.json"` — the sandbox pre-flight (`docker.ts`), the Docker
// bind mounts (`config.ts`), the credentials-present probe (`index.ts`), and a
// couple of related lookups (`credentials.ts`, `skills/paths.ts`). That works
// today on every platform Claude Code ships on (POSIX + Windows both use
// `homedir()` as the anchor), but it leaves no escape hatch when:
//
//   - A user's Windows install is redirected (corporate `%USERPROFILE%` policy)
//   - Anthropic moves the location in a future Claude Code release
//   - Someone wants to test against a sandboxed Claude config without touching
//     their real `~/.claude/`
//
// `CLAUDE_CONFIG_DIR` / `CLAUDE_CONFIG_JSON` env overrides are the documented
// escape hatch. Default behaviour is unchanged.
//
// Tracking: issue #87 §2 — Windows Claude CLI config location.

import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "../system/env.js";

// `env.claudeConfigDir` / `env.claudeConfigJson` are captured at module load
// from `process.env.CLAUDE_CONFIG_DIR` / `CLAUDE_CONFIG_JSON`. The `override`
// parameter on each helper exists so tests can exercise the override path
// without spawning a subprocess (production always passes nothing →
// `env.X` wins, and the helper preserves identical behaviour).

// A blank override means "unset", not "resolve against the empty string": `??`
// would pass `""` through, and `join("", ".claude.json")` yields the RELATIVE
// path `.claude.json`, which as the left side of a Docker `-v` mounts whatever
// sits in the cwd.
function definedPath(override: string | undefined): string | undefined {
  return override?.trim() || undefined;
}

/** Absolute path to the user's Claude Code config directory.
 *
 *  Default: `<home>/.claude` (where `home` defaults to `os.homedir()`).
 *  Override with `CLAUDE_CONFIG_DIR` env var. The `home` parameter exists
 *  for tests that thread a fake home through callers like
 *  `buildDockerSpawnArgs`; production passes nothing and gets `homedir()`. */
export function claudeConfigDir(home?: string, override: string | undefined = env.claudeConfigDir): string {
  return definedPath(override) ?? join(home ?? homedir(), ".claude");
}

/** Absolute path to the user's top-level Claude Code JSON config file.
 *
 *  Precedence: `CLAUDE_CONFIG_JSON` > `<CLAUDE_CONFIG_DIR>/.claude.json` > `<home>/.claude.json`.
 *
 *  The middle step is load-bearing: Claude Code keeps this file INSIDE
 *  `CLAUDE_CONFIG_DIR`, so resolving it from `home` while `claudeConfigDir()`
 *  honours the env var would point the two at different directories. A user who
 *  moved only `CLAUDE_CONFIG_DIR` then gets a bind mount for a file that does not
 *  exist, and Docker answers that with an empty directory rather than an error —
 *  the sandbox comes up with no config and nothing reports a problem (#2654).
 *  Verified against the CLI, which prints `File modified: <dir>/.claude.json` and
 *  leaves `~/.claude.json` untouched; the docs cover neither interaction. */
export function claudeConfigJson(
  home?: string,
  override: string | undefined = env.claudeConfigJson,
  dirOverride: string | undefined = env.claudeConfigDir,
): string {
  return definedPath(override) ?? join(definedPath(dirOverride) ?? home ?? homedir(), ".claude.json");
}

/** Absolute path to the user's Claude Code credentials file
 *  (`<claudeConfigDir>/.credentials.json`). */
export function claudeCredentialsPath(home?: string, dirOverride?: string): string {
  return join(claudeConfigDir(home, dirOverride), ".credentials.json");
}

/** Absolute path to the user's Claude Code skills directory
 *  (`<claudeConfigDir>/skills`). */
export function claudeSkillsDir(home?: string, dirOverride?: string): string {
  return join(claudeConfigDir(home, dirOverride), "skills");
}
