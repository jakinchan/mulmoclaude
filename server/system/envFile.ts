// Pure `.env` application, with no module-load side effect.
//
// Split out from `loadEnv.ts` so importing this — as the tests do — can
// never read the repository's real `.env` or touch `process.env`. The
// one-shot call against the real ones lives in `loadEnv.ts`, which is
// the side-effect entrypoint and is imported for that effect alone.

import path from "node:path";
import { mergeLaunchEnv, parseEnvFile } from "../utils/launch-env.mjs";

/** The shape `process.env` presents. Spelled out rather than using the
 *  `NodeJS` global namespace, which this repo's eslint config does not
 *  declare. */
export type MutableEnv = Record<string, string | undefined>;

/** Apply `<cwd>/.env` to `target`, leaving keys it already defines
 *  alone, and return the names that lost.
 *
 *  Reuses the launcher's `parseEnvFile` + `mergeLaunchEnv`, so the
 *  parse is `dotenv.parse` and the precedence is the same no-override
 *  rule `dotenv/config` applied — only the reporting is new. */
export function applyEnvFile(cwd: string, target: MutableEnv): string[] {
  const { parsed } = parseEnvFile(path.join(cwd, ".env"));
  const { loadedKeys, skippedKeys } = mergeLaunchEnv(target, parsed);
  for (const key of loadedKeys) target[key] = parsed[key];
  return skippedKeys;
}
