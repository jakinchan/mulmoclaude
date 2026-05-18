// MCP ToolDefinition for `manageEncore` (operational kinds only).
//
// Structural kinds (setup / amendDefinition) moved to the sibling
// `defineEncoreDefinition.ts`. The server-side dispatcher still
// accepts them on the wire for backward compat (the new
// `handleDefineEncore` translates to them internally), but the
// LLM-facing enum here is narrower so the LLM picks `defineEncore`
// for DSL composition and `manageEncore` for everything that
// happens after the obligation exists.
//
// Schema details live in the help file (`config/helps/encore-dsl.md`)
// which the host syncs into the workspace at every startup — keeping
// this `description` short and letting Claude lazy-read the help file
// for full grammar is the teaching strategy (see
// plans/feat-encore-plugin.md "Teaching the DSL to Claude").

import type { ToolDefinition } from "gui-chat-protocol";
import type { ResolvedRoute } from "../meta-types";
import { META } from "./manageEncoreMeta";

// Derive TOOL_NAME from META so the schema, MCP-bridge dispatch,
// and Vue executor can't drift apart. The host aggregators
// (TOOL_NAMES, API_ROUTES, WORKSPACE_PATHS) read META; everything
// downstream reads from here.
export const TOOL_NAME = META.toolName;

/** Resolved-route shape Encore exposes to the browser via
 *  `pluginEndpoints("encore")`. Derived from META so adding a new
 *  apiRoutes key flows into the type without manual edits. Shared
 *  between manageEncore and defineEncore — both POST to the same
 *  dispatch endpoint. */
export type EncoreEndpoints = { readonly [K in keyof typeof META.apiRoutes]: ResolvedRoute };

/** Action kinds the LLM is allowed to invoke via the `manageEncore`
 *  MCP tool. Operational only — structural (setup / amendDefinition)
 *  lives on the `defineEncore` tool. `resolveNotification` is
 *  deliberately excluded because it's a browser-only action
 *  dispatched by the /encore page on mount (calls `startChat`
 *  server-side; calling it from inside an existing chat would spawn
 *  a duplicate chat).
 *
 *  When adding a new action kind, decide whether it's structural
 *  (writes/edits a DSL document → add to defineEncore) or
 *  operational (acts on existing obligation state → add here). */
export const LLM_ENCORE_KINDS = ["markStepDone", "markTargetSkipped", "recordValues", "query", "appendNote", "snooze", "unsnooze"] as const;

/** Every action kind the server-side dispatch handles, including
 *  browser-only ones and the structural kinds the server keeps for
 *  backward compat. NOT the enum exposed to Claude — used by the
 *  dispatch.ts switch and by tests. */
export const ALL_ENCORE_KINDS = [...LLM_ENCORE_KINDS, "resolveNotification", "setup", "amendDefinition", "defineEncore"] as const;

const toolDefinition: ToolDefinition = {
  type: "function",
  name: TOOL_NAME,
  prompt:
    "Once an Encore obligation exists, use manageEncore to record what happened (markStepDone / markTargetSkipped / recordValues / appendNote), to defer reminders (snooze / unsnooze), or to query (query). " +
    "For composing a NEW obligation or amending an existing one's DSL, use the sibling defineEncore tool. " +
    "Read `config/helps/encore-dsl.md` before calling — it documents every action's call shape and bell-clearing semantics.",
  description: "Record progress on existing Encore obligations — close steps, skip targets, snooze, query.",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...LLM_ENCORE_KINDS],
        description: "Which Encore action to perform.",
      },
    },
    required: ["kind"],
    // The handler validates the rest of the args per-kind with Zod
    // (see server/encore/dispatch.ts). Keeping the top-level schema
    // minimal lets Claude compose any shape and surface structural
    // errors via the help-file-pointer messages, rather than fighting
    // a strict JSON-schema validator that doesn't know about
    // cross-field rules.
    additionalProperties: true,
  },
};

export default toolDefinition;
