// Encore cadence math. Pure functions — no fs, no clock injection
// here (the caller passes `now` explicitly). Per the DSL spec each
// cadence shape determines:
//
//   - which slot "now" falls into (currentCycleSlot)
//   - the cycle's start date (cycleStart)
//   - the cycle's deadline date (cycleDeadline)
//   - the on-disk cycle id string (formatCycleId), used to name the
//     per-cycle file under obligations/<id>/<cycleId>.md
//
// The five v1 cadences are: annual, biannual, monthly, weekly, daily.
// Quarterly / one-shot / custom-cron are out of scope. Days are
// capped at 28 in validators to avoid February edge cases; the math
// here trusts validated input. ISO dates everywhere (YYYY-MM-DD).

import { z } from "zod";

// ── ISO date helpers ────────────────────────────────────────────

/** Format a Date as `YYYY-MM-DD` in UTC. The whole cadence math is
 *  date-only (no time-of-day), so UTC vs local mostly doesn't
 *  matter — but staying consistent in one zone makes "is today on
 *  or after deadline?" boundaries deterministic across servers. */
export function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function utcDate(y: number, mZero: number, d: number): Date {
  return new Date(Date.UTC(y, mZero, d));
}

/** Add N calendar days to an ISO date (returns ISO). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = utcDate(y, m - 1, d + days);
  return isoDate(dt);
}

/** Lexicographic ISO compare. -1 / 0 / 1. */
export function compareIsoDates(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ── ISO week helpers (used by weekly cadence) ───────────────────

/** ISO 8601 week number for a date. The ISO week year matches the
 *  Thursday of the week — handy for the early-Jan / late-Dec edge
 *  cases where a date's calendar year and ISO-week year differ. */
function isoWeekYearAndNumber(d: Date): { year: number; week: number } {
  // Copy to avoid mutating caller.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Move to Thursday of this ISO week.
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  const firstThursdayWeekStart = new Date(firstThursday);
  firstThursdayWeekStart.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum);
  const diffMs = t.getTime() - firstThursdayWeekStart.getTime();
  const week = 1 + Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
  return { year: t.getUTCFullYear(), week };
}

/** Monday of the given ISO week (returns ISO date). */
function isoWeekMonday(year: number, week: number): string {
  // Jan 4 is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const mondayOfWeek1 = new Date(jan4);
  mondayOfWeek1.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  const target = new Date(mondayOfWeek1);
  target.setUTCDate(mondayOfWeek1.getUTCDate() + (week - 1) * 7);
  return isoDate(target);
}

// ── Cadence Zod schema ──────────────────────────────────────────

const dayInMonth = z.number().int().min(1).max(28);
const monthOfYear = z.number().int().min(1).max(12);

const cycleEntry = z.object({ month: monthOfYear, day: dayInMonth });

const annual = z.object({
  type: z.literal("annual"),
  cycles: z.tuple([cycleEntry]),
});

const biannual = z.object({
  type: z.literal("biannual"),
  cycles: z.tuple([cycleEntry, cycleEntry]),
});

const monthly = z.object({
  type: z.literal("monthly"),
  day: dayInMonth,
});

const DAY_OF_WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayOfWeek = (typeof DAY_OF_WEEK)[number];

const weekly = z.object({
  type: z.literal("weekly"),
  dayOfWeek: z.enum(DAY_OF_WEEK),
});

const daily = z.object({
  type: z.literal("daily"),
});

export const CadenceSchema = z.discriminatedUnion("type", [annual, biannual, monthly, weekly, daily]).superRefine((cad, ctx) => {
  // The biannual ordering check is on the inner type so it composes
  // into the discriminated union; we re-apply it here so .parse on
  // the union surfaces the same error.
  if (cad.type === "biannual") {
    const [a, b] = cad.cycles;
    if (a.month > b.month || (a.month === b.month && a.day >= b.day)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "biannual cycles must be in calendar order (first cycle before second)",
        path: ["cycles"],
      });
    }
  }
});

export type Cadence = z.infer<typeof CadenceSchema>;

// ── Slot identification ─────────────────────────────────────────

export type CycleSlot =
  | { kind: "annual"; year: number }
  | { kind: "biannual"; year: number; half: 1 | 2 }
  | { kind: "monthly"; year: number; month: number }
  | { kind: "weekly"; year: number; week: number }
  | { kind: "daily"; iso: string };

/** Find the cycle slot a given date falls into for this cadence.
 *  "Falls into" = the slot whose [start, deadline] range contains
 *  `now`; for annual / biannual we pick the slot whose deadline is
 *  the next upcoming one (so the cycle is "active" until its
 *  deadline passes; the day AFTER the deadline rolls into the next
 *  cycle, matching the spec's cycle-start = day-after-prev-deadline
 *  rule). */
export function currentCycleSlot(cadence: Cadence, now: Date): CycleSlot {
  const year = now.getUTCFullYear();
  if (cadence.type === "annual") {
    const { month, day } = cadence.cycles[0];
    const thisYearDeadline = utcDate(year, month - 1, day);
    return { kind: "annual", year: now <= thisYearDeadline ? year : year + 1 };
  }
  if (cadence.type === "biannual") {
    const [c1, c2] = cadence.cycles;
    const d1 = utcDate(year, c1.month - 1, c1.day);
    const d2 = utcDate(year, c2.month - 1, c2.day);
    if (now <= d1) return { kind: "biannual", year, half: 1 };
    if (now <= d2) return { kind: "biannual", year, half: 2 };
    return { kind: "biannual", year: year + 1, half: 1 };
  }
  if (cadence.type === "monthly") {
    const month0 = now.getUTCMonth();
    const deadlineThisMonth = utcDate(year, month0, cadence.day);
    if (now <= deadlineThisMonth) {
      return { kind: "monthly", year, month: month0 + 1 };
    }
    const next = utcDate(year, month0 + 1, 1);
    return { kind: "monthly", year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
  }
  if (cadence.type === "weekly") {
    const target = cadence.dayOfWeek;
    const targetIdx = DAY_OF_WEEK.indexOf(target);
    const { year: isoYear, week } = isoWeekYearAndNumber(now);
    const monday = isoWeekMonday(isoYear, week);
    const deadlineThisWeek = addDays(monday, targetIdx);
    if (isoDate(now) <= deadlineThisWeek) {
      return { kind: "weekly", year: isoYear, week };
    }
    const nextMondayIso = addDays(monday, 7);
    const nextMondayDate = new Date(`${nextMondayIso}T00:00:00Z`);
    const { year: ny, week: nw } = isoWeekYearAndNumber(nextMondayDate);
    return { kind: "weekly", year: ny, week: nw };
  }
  // daily
  return { kind: "daily", iso: isoDate(now) };
}

/** ISO date of the cycle's deadline. */
export function cycleDeadline(cadence: Cadence, slot: CycleSlot): string {
  if (cadence.type === "annual" && slot.kind === "annual") {
    const { month, day } = cadence.cycles[0];
    return isoDate(utcDate(slot.year, month - 1, day));
  }
  if (cadence.type === "biannual" && slot.kind === "biannual") {
    const c = cadence.cycles[slot.half - 1];
    return isoDate(utcDate(slot.year, c.month - 1, c.day));
  }
  if (cadence.type === "monthly" && slot.kind === "monthly") {
    return isoDate(utcDate(slot.year, slot.month - 1, cadence.day));
  }
  if (cadence.type === "weekly" && slot.kind === "weekly") {
    const monday = isoWeekMonday(slot.year, slot.week);
    const targetIdx = DAY_OF_WEEK.indexOf(cadence.dayOfWeek);
    return addDays(monday, targetIdx);
  }
  if (cadence.type === "daily" && slot.kind === "daily") {
    return slot.iso;
  }
  throw new Error(`cadence/slot mismatch: cadence.type=${cadence.type} slot.kind=${slot.kind}`);
}

/** ISO date of the cycle's start. For annual/biannual that's the
 *  day after the previous slot's deadline; for monthly the 1st of
 *  the month; weekly the Monday of the ISO week; daily same as
 *  deadline. */
export function cycleStart(cadence: Cadence, slot: CycleSlot): string {
  if (cadence.type === "annual" && slot.kind === "annual") {
    const { month, day } = cadence.cycles[0];
    const prevDeadline = isoDate(utcDate(slot.year - 1, month - 1, day));
    return addDays(prevDeadline, 1);
  }
  if (cadence.type === "biannual" && slot.kind === "biannual") {
    if (slot.half === 1) {
      const c2 = cadence.cycles[1];
      const prevDeadline = isoDate(utcDate(slot.year - 1, c2.month - 1, c2.day));
      return addDays(prevDeadline, 1);
    }
    const c1 = cadence.cycles[0];
    const prevDeadline = isoDate(utcDate(slot.year, c1.month - 1, c1.day));
    return addDays(prevDeadline, 1);
  }
  if (cadence.type === "monthly" && slot.kind === "monthly") {
    return isoDate(utcDate(slot.year, slot.month - 1, 1));
  }
  if (cadence.type === "weekly" && slot.kind === "weekly") {
    return isoWeekMonday(slot.year, slot.week);
  }
  if (cadence.type === "daily" && slot.kind === "daily") {
    return slot.iso;
  }
  throw new Error(`cadence/slot mismatch: cadence.type=${cadence.type} slot.kind=${slot.kind}`);
}

/** On-disk cycle id string. Stable / deterministic — used as the
 *  per-cycle markdown file name under obligations/<id>/<cycleId>.md. */
export function formatCycleId(slot: CycleSlot): string {
  switch (slot.kind) {
    case "annual":
      return `${slot.year}`;
    case "biannual":
      return `${slot.year}-h${slot.half}`;
    case "monthly":
      return `${slot.year}-${String(slot.month).padStart(2, "0")}`;
    case "weekly":
      return `${slot.year}-W${String(slot.week).padStart(2, "0")}`;
    case "daily":
      return slot.iso;
  }
}

/** Advance to the next slot after `current` for this cadence. Used
 *  by next-cycle provisioning when a cycle closes. */
export function nextSlot(cadence: Cadence, current: CycleSlot): CycleSlot {
  if (cadence.type === "annual" && current.kind === "annual") {
    return { kind: "annual", year: current.year + 1 };
  }
  if (cadence.type === "biannual" && current.kind === "biannual") {
    if (current.half === 1) return { kind: "biannual", year: current.year, half: 2 };
    return { kind: "biannual", year: current.year + 1, half: 1 };
  }
  if (cadence.type === "monthly" && current.kind === "monthly") {
    const next = utcDate(current.year, current.month, 1);
    return { kind: "monthly", year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
  }
  if (cadence.type === "weekly" && current.kind === "weekly") {
    const monday = isoWeekMonday(current.year, current.week);
    const nextMondayIso = addDays(monday, 7);
    const { year, week } = isoWeekYearAndNumber(new Date(`${nextMondayIso}T00:00:00Z`));
    return { kind: "weekly", year, week };
  }
  if (cadence.type === "daily" && current.kind === "daily") {
    return { kind: "daily", iso: addDays(current.iso, 1) };
  }
  throw new Error(`cadence/slot mismatch: cadence.type=${cadence.type} current.kind=${current.kind}`);
}
