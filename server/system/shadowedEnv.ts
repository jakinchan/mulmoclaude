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

// No brackets — the text formatter adds them (docs/logging.md).
const LOG_PREFIX = "shadowed-env";

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

/** Shape of an environment variable name. Anything else in the handoff
 *  is not a name we sent, and is dropped rather than rendered. */
const ENV_VAR_NAME = /^[A-Za-z_]\w*$/;

/** Parse the launcher's CSV into a clean key list: trimmed, de-duped,
 *  sorted. Sorted because the id is built from it and dotenv's parse
 *  order must not decide whether an entry counts as "already seen".
 *
 *  Tokens that aren't env var NAMES are dropped. The launcher only ever
 *  sends `Object.keys(...)`, so this can't fire on our own output — but
 *  the value arrives through `process.env`, which anything on the box
 *  can set, and a `KEY=secret` token would otherwise be typeset straight
 *  into a log line and a bell entry. Filtering here makes "names only" a
 *  property of the code rather than a promise about the producer. */
export function parseShadowedEnvKeys(raw: string | undefined): string[] {
  return raw ? normalizeShadowedEnvKeys(raw.split(",")) : [];
}

/** The same trim / validate / de-dupe / sort rule applied to keys that
 *  arrive as a list rather than a CSV — the server's own `.env` load
 *  (#2610) hands them over directly. Shared so both sources produce one
 *  identity for the same conflict. */
export function normalizeShadowedEnvKeys(keys: readonly string[]): string[] {
  const clean = keys.map((key) => key.trim()).filter((key) => ENV_VAR_NAME.test(key));
  return [...new Set(clean)].sort();
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
 *  something reported shadowed keys.
 *
 *  Two sources, one notification. The launcher covers the user's launch
 *  directory (#2604); `serverLoadKeys` covers the `.env` this process
 *  read from its own cwd (#2610) — which is where `yarn dev` lands, and
 *  had no signal at all before. Only one of the two is ever non-empty in
 *  practice, but they union rather than compete so neither can mask the
 *  other. */
export async function announceShadowedEnv(
  raw: string | undefined = process.env[SHADOWED_ENV_KEYS_VAR],
  serverLoadKeys: readonly string[] = [],
): Promise<ShadowedEnvDiagnostic | null> {
  const keys = normalizeShadowedEnvKeys([...parseShadowedEnvKeys(raw), ...serverLoadKeys]);
  const diagnostic = shadowedEnvDiagnostic(keys);
  // `""` matches no id, so with nothing shadowed every existing entry
  // counts as stale — a boot that finds the conflict resolved retracts
  // the warning instead of leaving it pointing at a fixed problem.
  const active = await inspectActive(diagnostic?.id ?? "");
  await clearStale(active.staleEntryIds);
  if (!diagnostic) return null;

  log.warn(LOG_PREFIX, diagnostic.message, { keys: diagnostic.keys });
  if (active.alreadyShowing) {
    log.debug(LOG_PREFIX, "already in active set; skipping republish", { id: diagnostic.id });
    return diagnostic;
  }
  publishShadowedEnv(diagnostic);
  return diagnostic;
}

function publishShadowedEnv(diagnostic: ShadowedEnvDiagnostic): void {
  publishNotification({
    id: diagnostic.id,
    kind: "system",
    // English fallback for the log line and the macOS Reminder push,
    // neither of which has vue-i18n; the UI reads `i18n` instead.
    title: "Shell env is overriding .env",
    body: diagnostic.message,
    action: { type: NOTIFICATION_ACTION_TYPES.none },
    priority: NOTIFICATION_PRIORITIES.high,
    i18n: diagnostic.i18n,
  });
}
