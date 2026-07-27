// macOS Reminder notification sink (#789).
//
// On darwin, every `publishNotification()` call in
// `server/events/notifications.ts` also creates a reminder in the
// user's default Reminders list. The iCloud Reminders sync then
// mirrors the entry to the user's iPhone, which delivers the
// system notification.
//
// **Opt-out, on by default on darwin.** Set
// `DISABLE_MACOS_REMINDER_NOTIFICATIONS=1` to silence the sink
// (e.g. on a shared dev machine where the iPhone owner shouldn't
// be pinged). On non-darwin platforms the sink is a silent no-op
// regardless of env.
//
// Design notes:
// - Title / body are passed as `argv` (after osascript's `--`
//   separator). Going through argv rather than `system attribute`
//   sidesteps the UTF-8 garbling that `system attribute` exhibits
//   on multi-byte input (#789 follow-up).
// - Failures (osascript not found, Reminders.app permission denied,
//   non-zero exit) log a warn and resolve. They MUST NOT throw —
//   `publishNotification` itself wraps every sink in try/catch but
//   we keep the local guarantee here too so future call-sites can't
//   trip on it.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { env } from "./env.js";
import { isMacosRemindersEnabled, loadSettings, type AppSettings } from "./config.js";
import { log } from "./logger/index.js";

// Re-declared (instead of `NodeJS.Platform`) so the file doesn't need
// a `NodeJS` global reference, which the no-undef lint rule doesn't
// see in type-only positions. Mirrors the same workaround used in
// `server/agent/config.ts`.
type Platform = "aix" | "android" | "darwin" | "freebsd" | "haiku" | "linux" | "openbsd" | "sunos" | "win32" | "cygwin" | "netbsd";

// AppleScript reads `title` / `body` from the script's `argv` (passed
// after `--` on the osascript command line). Going through argv rather
// than `system attribute "FOO"` avoids the UTF-8 garble that
// `system attribute` exhibits on multi-byte characters — argv is
// always handed to the script as Unicode text.
const SCRIPT = [
  "on run argv",
  "    set t to item 1 of argv",
  "    set b to item 2 of argv",
  '    tell application "Reminders"',
  '        if b is "" then',
  "            make new reminder in default list with properties {name:t, due date:(current date)}",
  "        else",
  "            make new reminder in default list with properties {name:t, body:b, due date:(current date)}",
  "        end if",
  "    end tell",
  "end run",
].join("\n");

export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

interface Deps {
  spawner: Spawner;
  platform: Platform;
  // Opt-out flag (#789): on darwin the sink is enabled by default.
  // Set DISABLE_MACOS_REMINDER_NOTIFICATIONS=1 to silence it.
  disabled: boolean;
}

// Auto-disable inside `node:test`. The runner sets
// `NODE_TEST_CONTEXT` on the child process so we can detect it
// here. Without this gate, any test that goes through
// `publishNotification` (e.g. the route-level scheduleTest tests)
// fires real osascript and pollutes Reminders.app.
//
// Narrowed to the canonical `"child-v8"` value (the only one node's
// test runner currently emits) rather than "any non-empty string"
// — that limits the false-positive surface if a user happens to
// have NODE_TEST_CONTEXT exported in their dev shell with some
// other sentinel value (codex review on PR #808).
const NODE_TEST_CONTEXT_VALUES = new Set(["child-v8"]);

function isInsideNodeTest(): boolean {
  const value = process.env.NODE_TEST_CONTEXT;
  return typeof value === "string" && NODE_TEST_CONTEXT_VALUES.has(value);
}

const autoDisabledForTests = isInsideNodeTest();

/**
 * Resolved per call, never cached: the Settings toggle (#2617) changes
 * `settings.json` while the server runs, and a value frozen at module
 * load would keep firing reminders until a restart — which, for a
 * toggle whose entire job is to stop them, reads as broken.
 *
 * The env flag wins over the setting so an existing
 * `DISABLE_MACOS_REMINDER_NOTIFICATIONS=1` invocation keeps silencing
 * the sink no matter what is stored. Nothing is lost for the users this
 * setting exists for — an icon launch passes no env at all.
 */
export function resolveMacosReminderDisabled(input: { envDisabled: boolean; insideNodeTest: boolean; settingEnabled: boolean }): boolean {
  if (input.envDisabled || input.insideNodeTest) return true;
  return !input.settingEnabled;
}

/**
 * Built per call from a settings reader, never memoised — a `disabled`
 * captured once would keep firing reminders after the Settings toggle
 * turned them off, until a restart.
 */
export function buildMacosReminderDeps(input: { platform: Platform; readSettings: () => AppSettings; envDisabled: boolean; insideNodeTest: boolean }): Deps {
  return {
    spawner: spawn,
    platform: input.platform,
    disabled: resolveMacosReminderDisabled({
      envDisabled: input.envDisabled,
      insideNodeTest: input.insideNodeTest,
      settingEnabled: isMacosRemindersEnabled(input.readSettings()),
    }),
  };
}

// Observability hook — log once at module load if the auto-disable
// fired but the user didn't set the explicit DISABLE_… flag. Lets a
// dev who has NODE_TEST_CONTEXT inherited from their shell notice
// why their reminders aren't firing. We only log on darwin to avoid
// noise on Linux / Windows where the sink is silent anyway.
if (autoDisabledForTests && !env.disableMacosReminderNotifications && process.platform === "darwin") {
  log.info(
    "macos-notify",
    "auto-disabled because NODE_TEST_CONTEXT is set; export it only in test runners or set DISABLE_MACOS_REMINDER_NOTIFICATIONS=1 to silence this sink intentionally",
    {
      nodeTestContext: process.env.NODE_TEST_CONTEXT,
    },
  );
}

export function pushToMacosReminder(title: string, body?: string): Promise<void> {
  const platform = process.platform as Platform;
  // Off darwin the sink is a no-op, so don't pay for the synchronous
  // settings read just to reach the same answer.
  if (platform !== "darwin") return Promise.resolve();
  return pushToMacosReminderWithDeps(
    buildMacosReminderDeps({
      platform,
      readSettings: loadSettings,
      envDisabled: env.disableMacosReminderNotifications,
      insideNodeTest: autoDisabledForTests,
    }),
    title,
    body,
  );
}

// Internal — exposed for tests. Lets the test suite inject a fake
// spawn / platform / disabled triple without touching real env or
// firing real subprocesses.
export function pushToMacosReminderWithDeps(deps: Deps, title: string, body?: string): Promise<void> {
  if (deps.platform !== "darwin") return Promise.resolve();
  if (deps.disabled) return Promise.resolve();

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // Title / body ride on argv so AppleScript receives them as
      // Unicode text. The trailing `--` is osascript's separator
      // between its own options and the script's `argv`.
      child = deps.spawner("osascript", ["-e", SCRIPT, "--", title, body ?? ""], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      log.warn("macos-notify", "spawn failed", { error: String(err) });
      resolve();
      return;
    }

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      log.warn("macos-notify", "subprocess error", { error: String(err) });
      resolve();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        log.warn("macos-notify", "osascript exited non-zero", {
          code,
          stderr: stderr.trim().slice(0, 500),
        });
      }
      resolve();
    });
  });
}
