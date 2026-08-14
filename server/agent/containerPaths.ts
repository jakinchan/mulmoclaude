// Where the workspace is mounted INSIDE the agent's Docker sandbox.
//
// A leaf module on purpose. `config.ts` re-exports it (so every existing
// `from "./config.js"` import keeps working), but `config.ts` itself imports
// `mcp-tools/index.js` — so an mcp-tool reaching back into `config.ts` for
// this one string closes a cycle and the tool array is read before it is
// initialised. Import it from here instead.

/** The container-side path of the workspace bind mount (see the `-v` argument
 *  built in `config.ts`). A sandboxed agent's absolute paths carry this prefix
 *  while the server process that serves its tool calls is on the host. */
export const CONTAINER_WORKSPACE_PATH = "/home/node/mulmoclaude";
