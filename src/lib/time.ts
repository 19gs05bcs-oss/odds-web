/**
 * Single source of truth for "what time/day is it" across the app.
 *
 * Everything user-facing (kickoff clock, day buckets, "today") is expressed in
 * DISPLAY_TZ — a European zone — instead of the runtime's local zone
 * (server = UTC, browser = whatever the visitor has) or Europe/Istanbul.
 * Override with NEXT_PUBLIC_DISPLAY_TZ (any IANA zone) if the target market changes.
 *
 * This module has no server-only imports so it is safe in client components.
 */
export const DISPLAY_TZ: string = process.env.NEXT_PUBLIC_DISPLAY_TZ || "Europe/Berlin";

export type ZonedParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  /** 0 = Sunday … 6 = Saturday (same as Date#getDay) */
  weekday: number;
};

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `tz` (zero-padded strings, DST-aware). */
export function zonedParts(input: Date | string | number, tz: string = DISPLAY_TZ): ZonedParts | null {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(d)) out[p.type] = p.value;
  // Some engines emit "24" at midnight even with h23 — normalise.
  const hour = out.hour === "24" ? "00" : out.hour;
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour,
    minute: out.minute,
    weekday: WEEKDAY_INDEX[out.weekday] ?? 0,
  };
}

/** "HH:mm" kickoff clock in DISPLAY_TZ, or "" when the input is missing/invalid. */
export function clockInTz(input: Date | string | number | null | undefined, tz: string = DISPLAY_TZ): string {
  if (input == null || input === "") return "";
  const p = zonedParts(input, tz);
  return p ? `${p.hour}:${p.minute}` : "";
}

/** Calendar day "YYYY-MM-DD" of an instant in DISPLAY_TZ, or "" when invalid. */
export function dayKeyInTz(input: Date | string | number | null | undefined, tz: string = DISPLAY_TZ): string {
  if (input == null || input === "") return "";
  const p = zonedParts(input, tz);
  return p ? `${p.year}-${p.month}-${p.day}` : "";
}

/** Today's calendar day "YYYY-MM-DD" in DISPLAY_TZ. */
export function todayInTz(tz: string = DISPLAY_TZ): string {
  return dayKeyInTz(new Date(), tz);
}

/** Shift a "YYYY-MM-DD" key by whole days (pure calendar arithmetic, no TZ involved). */
export function shiftDayKey(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
