// A handler's reply, made safe to hand to Firestore (#2634).
//
// Firestore rejects `undefined` at ANY depth, and the runner writes a handler's
// return value straight into the command document. So one `undefined` — anywhere
// in a reply, however deep — takes down the WHOLE reply: `updateDoc` throws,
// `status: "done"` never lands, and the remote waits until it times out. The
// symptom is not "one field missing" but "nothing works", which is what happened
// when a `work: undefined` reached MulmoTerminal's session list
// (receptron/mulmoterminal#1042).
//
// Strip rather than throw: a missing optional field costs one row's worth of
// detail, while a throw costs the user the entire reply — the very outcome this
// exists to prevent. The report is what keeps it from being silent, because an
// undeclared stripped key IS a bug on the sending side, and Firestore's own error
// names the document rather than the field.
//
// NOT `ignoreUndefinedProperties` on the Firestore instance: that setting makes
// this class of bug disappear into "the value just doesn't arrive", with nothing
// logged and nothing to grep for.

/** Path reported for a reply that is itself `undefined` — it has no field name. */
export const ROOT_PATH = "(root)";

/** Every path holding `undefined`, in `a.b.0.c` form. Empty when the value is safe to write. */
export const undefinedPaths = (value: unknown, prefix = ""): string[] => {
  if (value === undefined) return [prefix || ROOT_PATH];
  if (value === null || typeof value !== "object") return [];
  const child = (key: string | number) => (prefix ? `${prefix}.${key}` : String(key));
  // Array.from, not flatMap: a SPARSE array's holes are skipped by flatMap/map, so
  // `[1, , 3]` would be reported clean and then written with a hole Firestore rejects.
  if (Array.isArray(value)) return Array.from(value).flatMap((item, index) => undefinedPaths(item, child(index)));
  return Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, child(key)));
};

/**
 * The same value with every `undefined` removed — object keys dropped, array holes
 * turned into `null` so the surrounding indexes still line up with what the sender
 * meant. Returns `unknown` because a stripped object is no longer the input type.
 */
export const stripUndefined = (value: unknown): unknown => {
  // The whole reply can be undefined (a handler with no explicit return); `null` is
  // what the runner already substitutes for a missing result.
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Array.from(value, (item) => stripUndefined(item));
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (item === undefined ? [] : [[key, stripUndefined(item)]])));
};

/** Does `path` match `pattern`, where `*` stands for exactly one segment?
 *  Segment-wise rather than by regex: no escaping of user-supplied dots, and no
 *  pattern can turn into a catastrophic backtrack. */
export const matchesPathPattern = (path: string, pattern: string): boolean => {
  const segments = path.split(".");
  const wanted = pattern.split(".");
  return segments.length === wanted.length && wanted.every((segment, index) => segment === "*" || segment === segments[index]);
};

/**
 * The paths worth reporting: everything the caller has NOT declared as
 * legitimately-optional (`"sessions.*.work"`).
 *
 * Takes paths rather than the value so a caller walks the reply once — the walk is
 * also what tells it whether stripping (a full copy) is needed at all.
 *
 * Both kinds have to be stripped — that is Firestore's rule, not a judgment — but
 * only one kind is a defect. Reporting both means reporting one on every reply,
 * which is how a warning stops being read.
 */
export const unexpectedPaths = (paths: readonly string[], expected: readonly string[] = []): string[] =>
  paths.filter((path) => !expected.some((pattern) => matchesPathPattern(path, pattern)));
