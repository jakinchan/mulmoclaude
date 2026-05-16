// Encore DSL Zod schema.
//
// One obligation = one DSL document, validated end-to-end on every
// setup / amendDefinition call. The discriminated union on `type`
// (payment | service) enforces `currency` required iff payment. The
// cross-field rules (cadence cycle-count, step-field ownership, at-
// expression validity, etc.) live in superRefine blocks at the leaf
// or document level.
//
// Naming convention (a deliberate distinction):
//   - KEBAB regex (slug ids): obligation id, target id, step id —
//     these become file/folder names and routes, so case-sensitive
//     paths matter.
//   - IDENTIFIER regex (field names): camelCase or kebab — Claude
//     composes "invoiceReceivedOn" / "paidOn" naturally and the
//     surrounding codebase uses camelCase identifiers everywhere.
//
// See plans/feat-encore-plugin.md §The Encore DSL for the full
// natural-language spec; this file is its executable form.

import { z } from "zod";
import { CadenceSchema } from "./cadence.js";
import { atExprSchema, parseAtExpression } from "./at-expression.js";
import { resolveAtExpression } from "./at-resolver.js";

const KEBAB = /^[a-z][a-z0-9-]*$/;
const IDENTIFIER = /^[a-z][a-zA-Z0-9_-]*$/;
const ISO_4217 = /^[A-Z]{3}$/;

const kebabId = z.string().regex(KEBAB, "must be kebab-case (lowercase letters, digits, hyphens; starts with a letter)");
const fieldName = z.string().regex(IDENTIFIER, "must be a valid identifier (lowercase start; letters / digits / _ / -)");

// ── formSchema field ────────────────────────────────────────────

const FIELD_TYPES = ["string", "text", "url", "email", "date", "number", "boolean", "enum"] as const;
export type FormFieldType = (typeof FIELD_TYPES)[number];

const FormField = z
  .object({
    name: fieldName,
    type: z.enum(FIELD_TYPES),
    label: z.string().min(1),
    required: z.boolean().optional(),
    placeholder: z.string().optional(),
    options: z.array(z.string().min(1)).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "enum") {
      if (!v.options || v.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "type=enum requires non-empty options[]",
          path: ["options"],
        });
      }
    } else if (v.options && v.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `options[] is only meaningful for type=enum; got type=${v.type}`,
        path: ["options"],
      });
    }
  });

export type FormFieldDef = z.infer<typeof FormField>;

const FormSchema = z.object({
  fields: z.array(FormField).min(1),
});

// ── target / step ───────────────────────────────────────────────

const Target = z.object({
  id: kebabId,
  displayName: z.string().min(1),
  /** Pre-fill map — field-name → default value. The LLM treats
   *  presence of a default as "don't ask; auto-record". Validated
   *  against formSchema in the doc-level superRefine. */
  defaults: z.record(z.string(), z.unknown()).optional(),
});

export type TargetDef = z.infer<typeof Target>;

const Severity = z.enum(["info", "warning", "urgent"]);
export type Severity = z.infer<typeof Severity>;

const FiringPhase = z.object({
  at: atExprSchema({ allowStepDeadline: true }),
  severity: Severity,
});

const Step = z.object({
  id: kebabId,
  displayName: z.string().min(1),
  /** When this step's deadline falls. Resolved against
   *  cycleStart / cycleDeadline — step-deadline anchor not allowed
   *  here (it would be self-referential). */
  deadline: atExprSchema({ allowStepDeadline: false }),
  firingPlan: z.array(FiringPhase).min(1),
  /** Field names this step is responsible for. Must reference
   *  existing formSchema field names; checked at document level. */
  fields: z.array(fieldName),
});

export type StepDef = z.infer<typeof Step>;

// ── carryForward ────────────────────────────────────────────────

const CarryForward = z.object({
  body: z.enum(["empty", "copy"]).default("empty"),
});

// ── top-level DSL (discriminated union on type) ─────────────────

const STATUS = ["active", "paused", "retired"] as const;

const sharedFields = {
  version: z.literal(1),
  /** Generated server-side from displayName at setup; the DSL Claude
   *  composes omits it. We keep the field optional in the input
   *  schema so amend operations work; setup explicitly strips. */
  id: kebabId.optional(),
  displayName: z.string().min(1),
  status: z.enum(STATUS).default("active"),
  /** Generated server-side at setup. */
  createdAt: z.string().optional(),

  cadence: CadenceSchema,
  targets: z.array(Target).min(1),
  steps: z.array(Step).min(1),
  formSchema: FormSchema,
  carryForward: CarryForward.optional(),
};

const PaymentDsl = z.object({
  ...sharedFields,
  type: z.literal("payment"),
  currency: z.string().regex(ISO_4217, "currency must be a 3-letter uppercase ISO 4217 code (e.g. JPY, USD, EUR)"),
});

const ServiceDsl = z.object({
  ...sharedFields,
  type: z.literal("service"),
});

/** Top-level DSL union. Input shape — the post-superRefine resolved
 *  shape lives in `EncoreDsl` below. */
export const EncoreDslInput = z.discriminatedUnion("type", [PaymentDsl, ServiceDsl]).superRefine((doc, ctx) => {
  // ── cross-field: target / step / field-name uniqueness ────────
  const targetIds = new Set<string>();
  for (const t of doc.targets) {
    if (targetIds.has(t.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate target id ${JSON.stringify(t.id)}`,
        path: ["targets"],
      });
    }
    targetIds.add(t.id);
  }

  const stepIds = new Set<string>();
  for (const s of doc.steps) {
    if (stepIds.has(s.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate step id ${JSON.stringify(s.id)}`,
        path: ["steps"],
      });
    }
    stepIds.add(s.id);
  }

  const fieldNames = new Set<string>();
  for (const f of doc.formSchema.fields) {
    if (fieldNames.has(f.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate formSchema field name ${JSON.stringify(f.name)}`,
        path: ["formSchema", "fields"],
      });
    }
    fieldNames.add(f.name);
  }

  // ── each formSchema field appears in exactly one step.fields[] ─
  const fieldClaims = new Map<string, string[]>();
  for (const s of doc.steps) {
    for (const fname of s.fields) {
      if (!fieldNames.has(fname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step ${JSON.stringify(s.id)} references unknown formSchema field ${JSON.stringify(fname)}`,
          path: ["steps"],
        });
        continue;
      }
      const claims = fieldClaims.get(fname) ?? [];
      claims.push(s.id);
      fieldClaims.set(fname, claims);
    }
  }
  for (const fname of fieldNames) {
    const claims = fieldClaims.get(fname) ?? [];
    if (claims.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `formSchema field ${JSON.stringify(fname)} is not claimed by any step.fields[]`,
        path: ["formSchema", "fields"],
      });
    } else if (claims.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `formSchema field ${JSON.stringify(fname)} is claimed by multiple steps: ${claims.map((id) => JSON.stringify(id)).join(", ")}`,
        path: ["formSchema", "fields"],
      });
    }
  }

  // ── target.defaults keys reference real formSchema fields ─────
  for (const t of doc.targets) {
    if (!t.defaults) continue;
    for (const key of Object.keys(t.defaults)) {
      if (!fieldNames.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `target ${JSON.stringify(t.id)} default for ${JSON.stringify(key)} references unknown formSchema field`,
          path: ["targets"],
        });
      }
    }
  }

  // ── each step's firingPlan is chronologically ordered against a
  // representative cycle. We use today as the cycle anchor here —
  // the absolute date doesn't matter, only the relative ordering of
  // phases — but we need numeric ISO comparison to pick this up.
  // Walk in declared order and assert non-decreasing dates.
  for (const s of doc.steps) {
    let stepDeadlineIso: string | undefined;
    try {
      const expr = parseAtExpression(s.deadline, { allowStepDeadline: false });
      stepDeadlineIso = resolveAtExpression(expr, { cycleStart: "2026-01-01", cycleDeadline: "2026-12-31" });
    } catch {
      // Schema-level parse error already raised; skip here.
      continue;
    }
    const anchors = { cycleStart: "2026-01-01", cycleDeadline: "2026-12-31", stepDeadline: stepDeadlineIso };
    let prev: string | null = null;
    for (let i = 0; i < s.firingPlan.length; i++) {
      const phase = s.firingPlan[i];
      let resolved: string;
      try {
        const expr = parseAtExpression(phase.at, { allowStepDeadline: true });
        resolved = resolveAtExpression(expr, anchors);
      } catch {
        continue;
      }
      if (prev !== null && resolved < prev) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step ${JSON.stringify(s.id)}: firingPlan[${i}].at ${JSON.stringify(phase.at)} resolves before the previous phase — phases must be chronologically ordered`,
          path: ["steps"],
        });
      }
      prev = resolved;
    }
  }
});

export type EncoreDsl = z.infer<typeof EncoreDslInput>;
