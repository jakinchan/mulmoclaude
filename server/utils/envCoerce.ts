// Env-var type coercion, shared by the server's env snapshot and by `yarn dev`'s
// Vite proxy.
//
// It lived inside `server/system/env.ts` until #2650 needed the SAME rule for the
// dev proxy: the proxy has to resolve `PORT` exactly as the backend does, or the
// two point at different servers — which is the bug #2650 is about. A second
// opinion about "is this a port" is that bug one level down, so the rule lives
// here and `server/system/env.ts` consumes it rather than owning it.
//
// `vite.config.ts` runs outside the server tsconfig, but it is bundled by esbuild
// and already imports `scripts/lib/*.ts`, so a plain TS module reaches it fine —
// and keeps `env.ts` type-checked, which routing this through a `.mjs` did not.

export interface IntRange {
  min?: number;
  max?: number;
}

/**
 * `Number()`-based integer coercion with an optional range, falling back when the
 * value is absent, empty, non-integer, or out of range.
 *
 * `Number()` — not `parseInt` — on purpose: it is what the server has always used,
 * so `0x1f`, `1e3`, `+3100` and `3100.0` coerce exactly as they did, and a
 * whitespace-only value coerces to 0. Anything stricter here would silently
 * disagree with the backend.
 */
export function asInt(value: string | undefined, fallback: number, opts: IntRange = {}): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  if (opts.min !== undefined && parsed < opts.min) return fallback;
  if (opts.max !== undefined && parsed > opts.max) return fallback;
  return parsed;
}

/** The port range the backend accepts, so both sides bound the value identically.
 *  `min: 0` is deliberate — 0 asks the OS for an ephemeral port. */
export const PORT_RANGE: IntRange = Object.freeze({ min: 0, max: 65_535 });

/** The port the backend binds when `PORT` says nothing usable. */
export const DEFAULT_PORT = 3001;
