// Workspace-relative path helpers for the Encore plugin. Pure
// string composition — no fs here; the io layer joins these with
// WORKSPACE_PATHS.encore to get absolute paths.
//
// Layout under data/plugins/encore/:
//
//   obligations/<obligationId>/index.md      ← DSL + free-form body
//   obligations/<obligationId>/<cycleId>.md  ← per-cycle state + body
//   pending-clear/<pendingId>.json           ← chat-on-mount tickets
//
// `obligationId` and `cycleId` flow through the kebab-id validator
// upstream (DSL schema) and the cadence id formatter — never raw
// user input, so the path-traversal hardening accounting-io.ts
// needs is unnecessary here. We still keep a safety assertion at
// each join to catch any future regression.

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function assertSafeSegment(label: string, value: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`encore: invalid ${label} ${JSON.stringify(value)} (must match ${SAFE_SEGMENT.source})`);
  }
}

export const OBLIGATIONS_DIRNAME = "obligations";
export const PENDING_CLEAR_DIRNAME = "pending-clear";

/** "obligations" — relative to the plugin root. */
export function obligationsDir(): string {
  return OBLIGATIONS_DIRNAME;
}

/** "obligations/<id>" — directory holding index.md + cycle files. */
export function obligationDir(obligationId: string): string {
  assertSafeSegment("obligationId", obligationId);
  return `${OBLIGATIONS_DIRNAME}/${obligationId}`;
}

/** "obligations/<id>/index.md" — the DSL document. */
export function obligationIndexPath(obligationId: string): string {
  return `${obligationDir(obligationId)}/index.md`;
}

/** "obligations/<id>/<cycleId>.md" — the per-cycle state file. */
export function cycleFilePath(obligationId: string, cycleId: string): string {
  assertSafeSegment("cycleId", cycleId);
  return `${obligationDir(obligationId)}/${cycleId}.md`;
}

/** "pending-clear/<pendingId>.json" — the chat-on-mount ticket. */
export function pendingClearPath(pendingId: string): string {
  assertSafeSegment("pendingId", pendingId);
  return `${PENDING_CLEAR_DIRNAME}/${pendingId}.json`;
}

/** Slugify a display name into a kebab-case id. Deterministic,
 *  ASCII-only, safe for use as a filesystem segment. Used by setup
 *  to generate an obligation id from the user-supplied
 *  displayName. */
export function slugify(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-") // collapse non-alphanumerics
    .replace(/^-+|-+$/g, "") // trim leading/trailing dashes
    .replace(/-{2,}/g, "-");
  if (!slug) return "obligation";
  // Slug must start with a letter (KEBAB regex in schema). If the
  // first char ended up as a digit, prefix "o-".
  if (!/^[a-z]/.test(slug)) return `o-${slug}`;
  return slug;
}
