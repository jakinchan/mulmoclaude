// Google plugin — server side. Thin dispatch over the shared engine in
// @mulmoclaude/core/google: the OAuth grant, token file, and the Calendar /
// Tasks / Drive REST calls are owned by core, so this tool, the host's
// settings UI, remote commands, and auth CLI all share one link state.
// Server-only (no Vue View) — results render as plain tool output in the
// chat. User-facing guidance stays host-neutral (#2128): the plugin runs on
// multiple hosts (MulmoClaude, MulmoTerminal) whose link flows differ, and
// each host's own help carries the specific steps.
//
// This file only wires the real engine into the router; the kind → call
// mapping lives in `core/dispatch.ts`, where it is testable with a stub.
import * as googleApi from "@mulmoclaude/core/google";
import { definePlugin } from "gui-chat-protocol";
import { GoogleArgs } from "./args";
import { executeGoogleDispatch } from "./core/dispatch";
import { TOOL_DEFINITION } from "./definition";

export { TOOL_DEFINITION };

export default definePlugin(({ log }) => ({
  TOOL_DEFINITION,

  async google(rawArgs: unknown) {
    return await executeGoogleDispatch({ api: googleApi, log }, GoogleArgs.parse(rawArgs));
  },
}));
