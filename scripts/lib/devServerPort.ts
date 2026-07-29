// Where `yarn dev`'s Vite proxy should send `/api` — the same port the backend
// binds (#2650).
//
// The backend honours `PORT`; Vite's proxy targets were literal `localhost:3001`.
// So `PORT=3100 yarn dev` moved only the server, and with a first instance still
// on 3001 the second browser silently rendered the FIRST instance's data — the
// proxy connects, it just connects to the wrong server.
//
// This lives in `scripts/lib/` rather than importing `server/system/env.ts`
// because `vite.config.ts` runs outside the server tsconfig (the same constraint
// that makes it duplicate the session-token path), and here it can be unit-tested
// without booting Vite.
//
// The `.env` VALUES are supplied by the caller, parsed with the launcher's
// `parseEnvFile` — the same `dotenv.parse` the server's own loader uses. Parsing
// the file here by hand would reintroduce the bug one level down: dotenv strips
// inline comments, honours an `export ` prefix and understands quoting, so
// `PORT=3100 # dev` would give the server 3100 and the proxy the default.

/** The backend's own default. Mirrors `env.port`'s fallback in `server/system/env.ts`;
 *  the two files cannot share a module, so a change there belongs here as well. */
export const DEFAULT_SERVER_PORT = 3001;

const MAX_PORT = 65_535;

/** A port number, or `null` for anything that is not one. Rejecting junk matters:
 *  an unvalidated value would become `http://localhost:NaN`, which fails per request
 *  at runtime instead of at startup where it can be explained. */
export const parseServerPort = (raw: string | undefined | null): number | null => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : null;
};

export interface ServerPortSources {
  processEnv?: Record<string, string | undefined>;
  /** `.env` as the launcher's `parseEnvFile` parsed it — NOT raw file text. */
  envFileValues?: Record<string, string | undefined> | null;
  /** Reported when a value was present but unusable, so a typo is not silently ignored. */
  onInvalid?: (source: string, raw: string) => void;
}

/**
 * The port the backend will bind: the environment first, then `.env`, then the
 * default — the order `server/system/loadEnv.ts` produces, where `.env` populates
 * `process.env` and an exported shell variable wins over the file.
 */
export const resolveServerPort = (sources: ServerPortSources = {}): number => {
  const candidates: { source: string; raw: string | undefined }[] = [
    { source: "PORT", raw: sources.processEnv?.PORT },
    { source: ".env PORT", raw: sources.envFileValues?.PORT },
  ];
  for (const { source, raw } of candidates) {
    const parsed = parseServerPort(raw);
    if (parsed !== null) return parsed;
    if (raw?.trim()) sources.onInvalid?.(source, raw);
  }
  return DEFAULT_SERVER_PORT;
};

/** The proxy targets, built from one port so the five entries cannot drift apart. */
export const serverOrigins = (port: number): { http: string; ws: string } => ({
  http: `http://localhost:${port}`,
  ws: `ws://localhost:${port}`,
});
