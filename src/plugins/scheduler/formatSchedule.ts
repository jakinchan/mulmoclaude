// Tasks store the daily trigger as `HH:MM` in UTC (that's what the engine fires on); the UI converts to the
// viewer's local zone so a user in Tokyo sees "Daily 05:00 JST" instead of "Daily 20:00 UTC".

import { isRecord } from "../../utils/types";

export interface DailySchedule {
  type: "daily";
  time: string; // "HH:MM" in UTC
}

export interface IntervalSchedule {
  type: "interval";
  intervalMs: number;
}

export type TaskSchedule = DailySchedule | IntervalSchedule | { type: string; [k: string]: unknown };

const DAILY_TIME_RE = /^(\d{1,2}):(\d{2})$/;

// Anchor to today (not 1970) so DST conversion is accurate — "20:00 UTC daily" can differ by an hour summer/winter in London.
function buildUtcInstant(utcHour: number, utcMinute: number, now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, utcMinute));
}

// Browsers without a zone abbreviation fall back to "GMT+9" — fine; the point is no manual UTC conversion.
const LOCAL_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

function extractHourMinuteTz(date: Date): { hourMinute: string; tzLabel: string } | null {
  try {
    const parts = LOCAL_TIME_FORMATTER.formatToParts(date);
    const hour = parts.find((part) => part.type === "hour")?.value ?? "";
    const minute = parts.find((part) => part.type === "minute")?.value ?? "";
    const tzLabel = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    if (!hour || !minute) return null;
    // Some runtimes return "24" for midnight under hour:"2-digit" — normalize so "Daily 24:00 JST" never appears.
    const normalizedHour = hour === "24" ? "00" : hour;
    return { hourMinute: `${normalizedHour}:${minute}`, tzLabel };
  } catch {
    return null;
  }
}

// Falls back to "Daily HH:MM UTC" on malformed input or missing Intl — callers never see null/throw.
export function formatDailyLocal(utcHHMM: string, now: Date = new Date()): string {
  const match = DAILY_TIME_RE.exec(utcHHMM);
  if (!match) return `Daily ${utcHHMM} UTC`;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) {
    return `Daily ${utcHHMM} UTC`;
  }
  const extracted = extractHourMinuteTz(buildUtcInstant(hour, minute, now));
  if (!extracted) return `Daily ${utcHHMM} UTC`;
  return `Daily ${extracted.hourMinute} ${extracted.tzLabel}`;
}

export function formatInterval(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return "Every ?";
  const mins = Math.round(intervalMs / 60_000);
  if (mins < 1) return "Every <1m";
  const hours = Math.floor(mins / 60);
  const restMins = mins % 60;
  if (hours === 0) return `Every ${mins}m`;
  // The engine fires on the exact intervalMs, so "Every 2h" for a 90-minute
  // task would misrepresent real behavior — keep the minute remainder.
  return restMins === 0 ? `Every ${hours}h` : `Every ${hours}h ${restMins}m`;
}

// Takes `unknown`: the schedule comes off a task JSON whose `type` is open-ended,
// and every field is verified here anyway, so callers don't need a matching type.
export function formatSchedule(schedule: unknown, now: Date = new Date()): string {
  if (isRecord(schedule)) {
    const { type, intervalMs, time } = schedule;
    if (type === "interval" && typeof intervalMs === "number") return formatInterval(intervalMs);
    if (type === "daily" && typeof time === "string") return formatDailyLocal(time, now);
  }
  return JSON.stringify(schedule);
}
