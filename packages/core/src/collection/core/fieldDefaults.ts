// What a NEW record starts on (#2839). Shared so the Add form and
// `putItems mode:"create"` agree — a default the UI pre-fills but the tool
// ignores is worse than none, because only one of the two paths gets it.
//
// Only `enum` declares a `default` today. The other types are a separate
// question (literals for scalars, `today` / `now` sentinels for dates) and
// deliberately not modelled yet.

import type { CollectionFieldSpec, CollectionSchema } from "./schema.js";

/** The starting value for a field, or null when it declares none.
 *
 *  A `default` outside `values` resolves to null rather than being handed on.
 *  `putSchema` refuses to write one, but the key was silently ignored before
 *  #2839, so a stale value may already sit in a file that discovery still
 *  loads — and putting an impossible value into a form yields a rejected save
 *  the author cannot explain from what they see. */
export function fieldDefaultValue(field: CollectionFieldSpec): string | null {
  if (field.type !== "enum" || field.default === undefined) return null;
  return field.values.includes(field.default) ? field.default : null;
}

/** Every applicable default in a schema, keyed by field. */
export function schemaDefaults(schema: CollectionSchema): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, field] of Object.entries(schema.fields)) {
    const value = fieldDefaultValue(field);
    if (value !== null) out[key] = value;
  }
  return out;
}

/** The first `default` that names something `values` does not offer, for the
 *  WRITE path to refuse. Kept out of the parse so a file already carrying one
 *  keeps loading — see `fieldDefaultValue`. */
export function firstUnknownDefault(schema: CollectionSchema): { key: string; value: string; values: string[] } | null {
  for (const [key, field] of Object.entries(schema.fields)) {
    if (field.type !== "enum" || field.default === undefined) continue;
    if (!field.values.includes(field.default)) return { key, value: field.default, values: field.values };
  }
  return null;
}
