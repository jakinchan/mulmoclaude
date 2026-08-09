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
  /** Which ROOT this card's collection lives in, as a host-opaque scope token.
   *
   *  A collection's identity is `(root, slug)`, but a card payload named only
   *  the slug — so the host re-resolved it through whatever binding was current
   *  when the card RENDERED, which in a multi-root host may be a different
   *  project than the one the card was made in. A card built in project A could
   *  then read project B's data.
   *
   *  Host-injected (the LLM never sets it; it is not in the tool schema) and
   *  host-opaque: the engine only carries it and treats it as part of the
   *  card's identity. Pass an opaque project id, NEVER an absolute path — this
   *  payload reaches the browser and, through a view, an LLM-authored iframe.
   *
   *  Absent — the single-workspace case — the payload and every reconciliation
   *  decision are exactly what they were before this field existed. */
  scope?: string | undefined;
}

/** A card's identity for reconciliation. Two cards match only when they name
 *  the same collection IN THE SAME SCOPE, so two projects' `tasks` cards stay
 *  two cards. With no scope on either side this is the slug, unchanged. */
export function collectionCardKey(data: Pick<PresentCollectionData, "collectionSlug" | "scope">): string {
  return data.scope === undefined ? data.collectionSlug : `${data.scope}\u0000${data.collectionSlug}`;
}

/** Do two card payloads address the same card? The reconciliation predicate a
 *  host should use instead of comparing slugs. */
export function sameCollectionCard(
  one: Pick<PresentCollectionData, "collectionSlug" | "scope">,
  other: Pick<PresentCollectionData, "collectionSlug" | "scope">,
): boolean {
  return collectionCardKey(one) === collectionCardKey(other);
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

/** A trimmed non-empty string, or undefined. The tool's args arrive from an
 *  LLM (and `scope` from the host), so every field is validated the same way
 *  rather than trusted. */
const cleaned = (value: unknown): string | undefined => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);

/** Normalise the tool args into the card payload, or `null` when the required
 *  slug is missing. Pure and exported so the addressing rules are testable
 *  without going through a `ToolResult`.
 *
 *  Keys are added one at a time rather than spread with `undefined` values, so
 *  a payload with no `itemId` / `scope` OMITS those properties entirely — which
 *  is what keeps a single-workspace card byte-identical to what it has always
 *  been, in both `deepEqual` and JSON. */
export const toPresentCollectionData = (args: PresentCollectionArgs): PresentCollectionData | null => {
  const collectionSlug = cleaned(args?.collectionSlug);
  if (!collectionSlug) return null;
  const itemId = cleaned(args.itemId);
  const scope = cleaned(args.scope);
  return { collectionSlug, ...(itemId ? { itemId } : {}), ...(scope ? { scope } : {}) };
};

export const executePresentCollection = async (
  _context: ToolContext,
  args: PresentCollectionArgs,
): Promise<ToolResult<PresentCollectionData, PresentCollectionData>> => {
  const data = toPresentCollectionData(args);
  if (!data) {
    return {
      message: "presentCollection error: collectionSlug is required",
      instructions: "Tell the user you couldn't display the collection because no collection was specified, and ask which collection they mean.",
    };
  }
  const { collectionSlug, itemId } = data;
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
