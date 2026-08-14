import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import { resolve as resolvePath } from "path";
import { log } from "./logger/index.js";
import { env } from "./env.js";
import { SUBPROCESS_PROBE_TIMEOUT_MS } from "../utils/time.js";
import { claudeConfigDir, claudeConfigJson } from "../utils/claudeConfigPath.js";
import { CLAUDE_CODE_LABEL, DOCKERFILE_SHA_LABEL, IMAGE_INSPECT_FORMAT, parseSandboxImageInfo, sandboxImageWarnings } from "./sandboxImageInfo.js";

const execFileAsync = promisify(execFile);

const IMAGE_NAME = "mulmoclaude-sandbox";
const DOCKERFILE = "Dockerfile.sandbox";
const LABEL_KEY = DOCKERFILE_SHA_LABEL;
const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";

let _dockerEnabled: boolean | null = null;

function assertClaudeFiles(): void {
  const claudeDir = claudeConfigDir();
  const claudeJson = claudeConfigJson();
  const overrideHint = "Set CLAUDE_CONFIG_DIR / CLAUDE_CONFIG_JSON to point at your install if it lives elsewhere.";

  try {
    if (!statSync(claudeDir).isDirectory()) {
      log.error("sandbox", `${claudeDir} exists but is not a directory. ${overrideHint}`);
      process.exit(1);
    }
  } catch {
    log.error("sandbox", `${claudeDir} not found. Run 'claude' once to initialize. ${overrideHint}`);
    process.exit(1);
  }

  try {
    if (!statSync(claudeJson).isFile()) {
      log.error("sandbox", `${claudeJson} exists but is not a file. ${overrideHint}`);
      process.exit(1);
    }
  } catch {
    log.error("sandbox", `${claudeJson} not found. Run 'claude' once to initialize. ${overrideHint}`);
    process.exit(1);
  }
}

/** Pure daemon-liveness probe: `docker ps -q` succeeds only when the
 *  client is installed AND the daemon is reachable. No config or
 *  caching concerns — the optional-deps registry owns the PATH check
 *  and caching; this is just the liveness half. */
export async function isDockerLive(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["ps", "-q"], {
      timeout: SUBPROCESS_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function isDockerAvailable(): Promise<boolean> {
  if (env.disableSandbox) return false;
  if (_dockerEnabled !== null) return _dockerEnabled;
  assertClaudeFiles();
  _dockerEnabled = await isDockerLive();
  return _dockerEnabled;
}

function getDockerfileSha256(): string {
  const content = readFileSync(resolvePath(process.cwd(), DOCKERFILE));
  return createHash("sha256").update(content).digest("hex");
}

/** npm's current `latest` for the CLI, or `"latest"` when the registry can't be
 *  reached. Resolving it here rather than letting the Dockerfile say `@latest`
 *  is what makes the version knowable afterwards — and what invalidates the
 *  install layer when the CLI moves, instead of reusing a cached one (#2842). */
async function resolveClaudeCodeVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", CLAUDE_CODE_PACKAGE, "version"], { timeout: SUBPROCESS_PROBE_TIMEOUT_MS });
    const version = stdout.trim();
    return version.length > 0 ? version : "latest";
  } catch (err) {
    log.warn("sandbox", `could not resolve the latest ${CLAUDE_CODE_PACKAGE} version; building with @latest and leaving it unrecorded: ${String(err)}`);
    return "latest";
  }
}

async function buildImage(sha: string): Promise<void> {
  const claudeCodeVersion = await resolveClaudeCodeVersion();
  log.info("sandbox", "building with Claude CLI", { claudeCodeVersion });
  const args = [
    "build",
    "-t",
    IMAGE_NAME,
    "--label",
    `${LABEL_KEY}=${sha}`,
    "--label",
    `${CLAUDE_CODE_LABEL}=${claudeCodeVersion}`,
    "--build-arg",
    `CLAUDE_CODE_VERSION=${claudeCodeVersion}`,
    "-f",
    DOCKERFILE,
    "--load",
    ".",
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "inherit", "inherit"],
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker build exited with code ${code}`));
    });
  });
}

/** Read the image's labels and age, and say what they mean. Best-effort: a
 *  failure here must never block the sandbox, so it only ever logs. */
async function reportSandboxImage(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("docker", ["image", "inspect", IMAGE_NAME, "--format", IMAGE_INSPECT_FORMAT]);
    const info = parseSandboxImageInfo(stdout, Date.now());
    log.info("sandbox", "sandbox image", {
      claudeCodeVersion: info.claudeCodeVersion ?? "unrecorded",
      ageDays: info.ageDays,
    });
    sandboxImageWarnings(info).forEach((warning) => log.warn("sandbox", warning.message, warning.data));
  } catch (err) {
    log.warn("sandbox", `could not inspect the sandbox image: ${String(err)}`);
  }
}

async function needsRebuild(expectedSha: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", ["image", "inspect", IMAGE_NAME, "--format", IMAGE_INSPECT_FORMAT]);
    if (parseSandboxImageInfo(stdout, Date.now()).dockerfileSha === expectedSha) return false;
    log.info("sandbox", "Dockerfile.sandbox changed, rebuilding sandbox image...");
    return true;
  } catch {
    log.info("sandbox", "Building sandbox image (first time only, may take a minute)...");
    return true;
  }
}

export async function ensureSandboxImage(): Promise<void> {
  const expectedSha = getDockerfileSha256();
  if (await needsRebuild(expectedSha)) {
    await buildImage(expectedSha);
    log.info("sandbox", "Sandbox image built.");
  }
  await reportSandboxImage();
}
