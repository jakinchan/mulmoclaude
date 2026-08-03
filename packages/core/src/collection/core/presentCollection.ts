// presentCollection tool — definition + pure server-side executor.
//
// Isomorphic (no Vue, no Node): bundled to the browser as the plugin's
// `execute`, and run server-side via the host's plugin dispatch route. The
// executor only validates + echoes the addressing; the live schema + items
// are fetched client-side by the View through the host's /api/collections
// routes, so a bad slug surfaces as the View's "not found" state.

import type { ToolContext, ToolDefinition, ToolResult } from "gui-chat-protocol";

export const TOOL_NAME = "presentCollection";

/** Render payload carried in the tool result's `data` field; the View mounts
 *  off these. Same shape as the tool args. */
export interface PresentCollectionData {
  /** Slug of the collection to display (e.g. "clients", "invoices"). */
  collectionSlug: string;
  /** Optional primary-key value of a single item to open on mount. */
  itemId?: string | undefined;
}

export type PresentCollectionArgs = PresentCollectionData;

export const TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  name: TOOL_NAME,
  description:
    "Display a schema-driven collection inline in the chat as an interactive, editable card. Shows the collection's list of records. Pass `itemId` to open one specific record on mount.",
  parameters: {
    type: "object",
    properties: {
      collectionSlug: {
        type: "string",
        description: "The slug of the collection to display (e.g. 'clients', 'invoices', 'contacts').",
      },
      itemId: {
        type: "string",
        description: "Optional primary-key value of a single record to open in detail view on mount. Omit to show the full list.",
      },
    },
    required: ["collectionSlug"],
  },
  prompt: `After making changes to schema-driven collections, use ${TOOL_NAME} to present either the collection or the item`,
};

export const executePresentCollection = async (
  _context: ToolContext,
  args: PresentCollectionArgs,
): Promise<ToolResult<PresentCollectionData, PresentCollectionData>> => {
  const collectionSlug = typeof args?.collectionSlug === "string" ? args.collectionSlug.trim() : "";
  if (!collectionSlug) {
    return {
      message: "presentCollection error: collectionSlug is required",
      instructions: "Tell the user you couldn't display the collection because no collection was specified, and ask which collection they mean.",
    };
  }
  const itemId = typeof args.itemId === "string" && args.itemId.trim().length > 0 ? args.itemId.trim() : undefined;
  const data: PresentCollectionData = itemId ? { collectionSlug, itemId } : { collectionSlug };
  const target = itemId ? `${collectionSlug} / ${itemId}` : collectionSlug;
  return {
    message: `Presented collection ${target}`,
    // `data` is the view's source (also the host's render-eligibility signal);
    // `jsonData` is what the LLM sees. Same payload, two audiences.
    data,
    jsonData: data,
    // Phrased to stay correct for BOTH storage kinds without loading the
    // schema (this executor is deliberately pure/isomorphic): a writable
    // collection offers edit/create/delete in the card; a read-only
    // `dataSource` collection hides those and changes flow through its
    // data file instead.
    instructions:
      "The collection has been presented to the user as an interactive card. They can browse and open records directly; on a writable collection they can also edit, create, and delete (a read-only dataSource collection shows no edit controls — its records change by editing the backing data file). No further action is needed unless they ask.",
  };
};
