// The server's own `.env` load, replacing `import "dotenv/config"`.
//
// Same semantics as before — read `<cwd>/.env`, let an exported shell
// variable win — but it now REPORTS which keys the shell shadowed, so
// the boot diagnostic can say so (#2610). Under `dotenv/config` that
// information was computed and discarded, leaving `yarn dev` with no
// signal at all that an edited `.env` was being ignored.
//
// This stays a SIDE-EFFECTING IMPORT, first in `server/index.ts`, and
// must not become a function call there. ESM evaluates every import
// before the first statement of the module body, so a call on line 1 of
// the body would run after every imported module had already been
// evaluated — `server/workspace/paths.ts` reads `process.env` at its own
// module scope and would see an empty environment.
//
// Parsing is byte-identical to before: `parseEnvFile` calls
// `dotenv.parse`. Nothing else is lost — `DOTENV_CONFIG_*` (the only
// behaviour `dotenv/config` adds over `dotenv.config()`) is unused
// across the repo.

import path from "node:path";
import { mergeLaunchEnv, parseEnvFile } from "../utils/launch-env.mjs";

/** The shape `process.env` presents. Spelled out rather than using the
 *  `NodeJS` global namespace, which this repo's eslint config does not
 *  declare. */
export type MutableEnv = Record<string, string | undefined>;

/** Apply `<cwd>/.env` to `target`, leaving keys it already defines
 *  alone, and return the names that lost.
 *
 *  Both inputs are arguments rather than `process.cwd()` / `process.env`
 *  so this is drivable from a test — the module-level call below is the
 *  only place that touches the real ones. */
export function applyEnvFile(cwd: string, target: MutableEnv): string[] {
  const { parsed } = parseEnvFile(path.join(cwd, ".env"));
  const { loadedKeys, skippedKeys } = mergeLaunchEnv(target, parsed);
  for (const key of loadedKeys) target[key] = parsed[key];
  return skippedKeys;
}

const shadowed: readonly string[] = Object.freeze(applyEnvFile(process.cwd(), process.env));

/** Keys this process's own `.env` load lost to the shell. Empty under
 *  `npx mulmoclaude`, whose cwd is the package directory — there the
 *  launcher does the equivalent for the user's launch dir. */
export function shadowedByServerLoad(): readonly string[] {
  return shadowed;
}
