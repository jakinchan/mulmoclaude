// Common time constants in milliseconds. Avoids magic numbers like
// 3_600_000 scattered across the codebase.
//
// All server-side code should import from here instead of using raw
// numeric literals. When a specific duration is needed (e.g. a
// 5-second timeout), express it as `5 * ONE_SECOND_MS`.

export const ONE_SECOND_MS = 1_000;
export const ONE_MINUTE_MS = 60_000;
export const ONE_HOUR_MS = 3_600_000;
export const ONE_DAY_MS = 86_400_000;

/** Map time-unit suffixes (s/m/h) to milliseconds. */
export const TIME_UNIT_MS: Record<string, number> = {
  s: ONE_SECOND_MS,
  m: ONE_MINUTE_MS,
  h: ONE_HOUR_MS,
};

// ── Common timeout presets ──────────────────────────────────────
// Named timeouts for recurring patterns. Prefer these over inline
// `5 * ONE_SECOND_MS` when the same value is used in 3+ places.

/** Quick subprocess probe (docker ps, libreoffice --version, etc.) */
export const SUBPROCESS_PROBE_TIMEOUT_MS = 5 * ONE_SECOND_MS;

/** Debounce window for dev-plugin `dist/` watcher (#1159 PR3). Vite
 *  writes 4-5 files within ~100ms on a single rebuild; 300ms collapses
 *  the burst into one publish. */
export const DEV_PLUGIN_WATCH_DEBOUNCE_MS = 300;

/** Hard cap on how long the startup-failure path waits for
 *  `httpServer.close()` to drain in-flight connections before
 *  forcing `process.exit(1)`. SSE streams + WebSocket upgrades hold
 *  connections open indefinitely, so the graceful close alone isn't
 *  a fail-fast guarantee. */
export const STARTUP_FAILURE_FORCE_EXIT_MS = 5 * ONE_SECOND_MS;

/** Tiny grace after an uncaught exception / unhandled rejection so
 *  the final `log.error` line flushes to disk before the process
 *  bounces. Long enough for a synchronous append, short enough not
 *  to delay a crash-restart loop. */
export const FATAL_LOG_FLUSH_MS = 100;

/** Heavy subprocess work (libreoffice conversion, etc.) */
export const SUBPROCESS_WORK_TIMEOUT_MS = ONE_MINUTE_MS;

/** CLI subprocess timeout (claude -p for summarization, etc.) */
export const CLI_SUBPROCESS_TIMEOUT_MS = 5 * ONE_MINUTE_MS;

/** Maximum one-shot notification delay */
export const MAX_NOTIFICATION_DELAY_SEC = 3_600; // 1 hour in seconds
