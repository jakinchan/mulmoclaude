// Per-result UI state the host round-trips through `ToolResult.viewState`.
//
// The protocol types that field `Record<string, unknown>` — the host cannot
// know any plugin's shape — so the blob coming back is only as trustworthy as
// whatever wrote it (a previous app version, a restored session, another host).
// View and Preview both used to re-declare this interface and assert the blob
// into it, which claimed `userResponses` / `touched` were present when nothing
// had checked. One definition, one parser, both earned at runtime.

/** The shape this plugin stores under `ToolResult.viewState`. */
export interface FormViewState {
  userResponses: Record<string, unknown>;
  touched: string[];
  submitted?: boolean | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rebuild a `FormViewState` from a stored blob, keeping only the parts that
 *  really are the declared shape — a missing or malformed member degrades to
 *  its empty default rather than surfacing as a present-but-wrong field.
 *  Returns null when the blob is not an object at all, which is what a result
 *  that never carried view state looks like. */
export function toFormViewState(value: unknown): FormViewState | null {
  if (!isRecord(value)) return null;
  const touchedItems: unknown[] = Array.isArray(value.touched) ? value.touched : [];
  return {
    userResponses: isRecord(value.userResponses) ? value.userResponses : {},
    touched: touchedItems.filter((fieldId) => typeof fieldId === "string"),
    submitted: typeof value.submitted === "boolean" ? value.submitted : undefined,
  };
}
