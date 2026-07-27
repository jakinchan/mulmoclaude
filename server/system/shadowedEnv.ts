// Boot diagnostic: the shell is shadowing keys from the launch-dir `.env`.
//
// `.env` loses to an exported shell variable — dotenv's no-override rule,
// which the launcher implements correctly. The trouble is that losing is
// invisible: a stale `export GEMINI_API_KEY=…` in `~/.zshrc` means the
// user can fix `.env` any number of times and nothing changes, with
// nothing pointing at the shell (#2604).
//
// The launcher already knows exactly which keys lost (`skippedKeys` from
// `mergeLaunchEnv`) and forwards them on the spawned server's environment.
// This turns that into a bell entry, following the same shape as
// `announcePluginMetaDiagnostics`: stable id, dedupe against the active
// set so a reboot doesn't pile duplicates, i18n keys for the UI with
// English kept as the log / macOS-Reminder fallback.
//
// The server's own `import "dotenv/config"` has the same shadowing rule
// and reaches here through no path at all — see #2610.

import type { NotificationI18n } from "../../src/types/notification.js";
import { NOTIFICATION_ACTION_TYPES, NOTIFICATION_PRIORITIES } from "../../src/types/notification.js";
import { isLegacyNotifierPluginData, publishNotification } from "../events/notifications.js";
import { clear as clearNotifier, listAll as listActiveNotifications } from "../notifier/engine.js";
import { log } from "./logger/index.js";

/** Env var the launcher uses to hand over the shadowed key names. */
export const SHADOWED_ENV_KEYS_VAR = "MULMOCLAUDE_SHADOWED_ENV_KEYS";

const LOG_PREFIX = "[shadowed-env]";

const SHADOWED_ENV_TITLE_KEY = "shadowedEnv.title";
const SHADOWED_ENV_BODY_KEY = "shadowedEnv.body";

/** Cap on names rendered into one notification, matching the launcher's
 *  log-line cap — a large `.env` whose every key is shadowed should not
 *  produce an unreadable wall of text. */
const MAX_KEYS_SHOWN = 20;

export interface ShadowedEnvDiagnostic {
  /** Stable across restarts for the SAME set of shadowed keys, so the
   *  dedupe below recognises an entry the user has already seen. Changes
   *  when the set changes, so fixing one of two keys replaces the entry
   *  instead of leaving one that still names the fixed key. */
  id: string;
  /** English, for the log line and the macOS Reminder push — neither
   *  has vue-i18n. The UI prefers `i18n`. */
  message: string;
  keys: readonly string[];
  i18n: NotificationI18n;
}

/** Parse the launcher's CSV into a clean key list: trimmed, de-duped,
 *  sorted. Sorted because the id is built from it and dotenv's parse
 *  order must not decide whether an entry counts as "already seen". */
export function parseShadowedEnvKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  const keys = raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  return [...new Set(keys)].sort();
}

/** Render the key list for humans, capped. */
function describeKeys(keys: readonly string[]): string {
  if (keys.length <= MAX_KEYS_SHOWN) return keys.join(", ");
  return `${keys.slice(0, MAX_KEYS_SHOWN).join(", ")}, … (+${keys.length - MAX_KEYS_SHOWN} more)`;
}

/** The diagnostic for a set of shadowed keys, or `null` when there is
 *  nothing to report. Pure, so the id / text / cap rules are testable
 *  without a notifier or an environment. */
export function shadowedEnvDiagnostic(keys: readonly string[]): ShadowedEnvDiagnostic | null {
  if (keys.length === 0) return null;
  const shown = describeKeys(keys);
  return {
    id: `shadowed-env:${keys.join(",")}`,
    // List-first phrasing so one key and many keys read the same — the
    // translations rely on it to avoid singular/plural agreement.
    message: `Set in both the shell and .env: ${shown}. The shell value wins, so .env is ignored.`,
    keys,
    i18n: {
      titleKey: SHADOWED_ENV_TITLE_KEY,
      bodyKey: SHADOWED_ENV_BODY_KEY,
      bodyParams: { keys: shown },
    },
  };
}

const ID_PREFIX = "shadowed-env:";

interface ActiveShadowedEnv {
  /** True when an entry for exactly this key set is already showing. */
  alreadyShowing: boolean;
  /** Engine ids of entries describing a DIFFERENT key set. */
  staleEntryIds: string[];
}

/** Split the notifier's active set into "this exact conflict" and "an
 *  older shape of this conflict".
 *
 *  A read failure is not worth blocking the diagnostic over — the worst
 *  case is a duplicate entry the user can dismiss (same trade-off as the
 *  plugin-meta announce). */
async function inspectActive(currentId: string): Promise<ActiveShadowedEnv> {
  const result: ActiveShadowedEnv = { alreadyShowing: false, staleEntryIds: [] };
  try {
    for (const entry of await listActiveNotifications()) {
      const legacy = isLegacyNotifierPluginData(entry.pluginData) ? entry.pluginData : null;
      if (!legacy?.legacyId.startsWith(ID_PREFIX)) continue;
      if (legacy.legacyId === currentId) result.alreadyShowing = true;
      else result.staleEntryIds.push(entry.id);
    }
  } catch (err) {
    log.warn(LOG_PREFIX, "failed to snapshot active notifier state for dedup", { error: String(err) });
  }
  return result;
}

/** Drop entries describing a key set that is no longer the situation.
 *  Without this, fixing one of two shadowed keys leaves a bell entry
 *  still naming the key the user just fixed, next to the new accurate
 *  one — two notifications, one of them a lie. */
async function clearStale(entryIds: readonly string[]): Promise<void> {
  for (const entryId of entryIds) {
    try {
      await clearNotifier(entryId);
    } catch (err) {
      log.warn(LOG_PREFIX, "failed to clear a superseded entry", { entryId, error: String(err) });
    }
  }
}

/** Run at boot, after the notifier engine is initialised. No-ops unless
 *  the launcher reported shadowed keys. */
export async function announceShadowedEnv(raw: string | undefined = process.env[SHADOWED_ENV_KEYS_VAR]): Promise<ShadowedEnvDiagnostic | null> {
  const diagnostic = shadowedEnvDiagnostic(parseShadowedEnvKeys(raw));
  // Nothing shadowed now, but a previous boot may have said otherwise —
  // leaving that entry up would keep pointing at a conflict the user has
  // already resolved.
  if (!diagnostic) {
    await clearStale((await inspectActive("")).staleEntryIds);
    return null;
  }

  log.warn(LOG_PREFIX, diagnostic.message, { keys: diagnostic.keys });
  const active = await inspectActive(diagnostic.id);
  await clearStale(active.staleEntryIds);
  if (active.alreadyShowing) {
    log.debug(LOG_PREFIX, "already in active set; skipping republish", { id: diagnostic.id });
    return diagnostic;
  }
  publishNotification({
    id: diagnostic.id,
    kind: "system",
    title: "Shell env is overriding .env",
    body: diagnostic.message,
    action: { type: NOTIFICATION_ACTION_TYPES.none },
    priority: NOTIFICATION_PRIORITIES.high,
    i18n: diagnostic.i18n,
  });
  return diagnostic;
}
