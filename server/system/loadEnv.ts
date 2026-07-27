// The server's own `.env` load, replacing `import "dotenv/config"`.
//
// Same semantics as before — read `<cwd>/.env`, let an exported shell
// variable win — but it now REPORTS which keys the shell shadowed, so
// the boot diagnostic can say so (#2610). Under `dotenv/config` that
// information was computed and discarded, leaving `yarn dev` with no
// signal at all that an edited `.env` was being ignored.
//
// This module exists to be imported for its SIDE EFFECT, first in
// `server/index.ts`, and that import must not become a function call
// there. ESM evaluates every import before the first statement of the
// module body, so a call on line 1 of the body would run after every
// imported module had already been evaluated — `server/workspace/
// paths.ts` reads `process.env` at its own module scope and would see an
// unpopulated environment. That is measured, not assumed: moving the
// load into the body makes `paths.ts` resolve `~/mulmoclaude` instead of
// the `.env` value.
//
// The logic itself lives in `envFile.ts` precisely so a test can drive
// it without triggering the load below.
//
// `DOTENV_CONFIG_*` is deliberately NOT honoured. `dotenv/config` read
// `DOTENV_CONFIG_PATH` / `_OVERRIDE` / `_ENCODING` / `_DEBUG` /
// `_QUIET`; nothing in this repo — code, scripts, CI, Docker — ever set
// one, and they were never a documented way to configure the server. The
// file is always `<cwd>/.env` and the shell always wins. Reintroduce an
// option here only with a caller that needs it.

import { applyEnvFile } from "./envFile.js";

const shadowed: readonly string[] = Object.freeze(applyEnvFile(process.cwd(), process.env));

/** Keys this process's own `.env` load lost to the shell. Empty under
 *  `npx mulmoclaude`, whose cwd is the package directory — there the
 *  launcher does the equivalent for the user's launch dir. */
export function shadowedByServerLoad(): readonly string[] {
  return shadowed;
}
