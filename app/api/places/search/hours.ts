// Standalone "is this venue open at time X" check, isolated for
// debugging before the full objective filter gets built.
//
// Google's currentOpeningHours.periods entries look like:
//   { open:  { day: 0-6, hour, minute, date? },
//     close: { day: 0-6, hour, minute, date? } }
// day 0 = Sunday. A 24/7 venue is a single period with open day 0,
// hour 0 and no close. Overnight periods have close.day != open.day.

export interface HoursPoint {
  day: number;
  hour: number;
  minute: number;
}

export interface OpeningPeriod {
  open?: HoursPoint;
  close?: HoursPoint;
}

export interface CurrentOpeningHours {
  openNow?: boolean;
  periods?: OpeningPeriod[];
}

export interface TargetTime {
  day: number; // 0 = Sunday, aligned with Google's convention
  hour: number;
  minute: number;
}

/**
 * Extract a comparable target time from a parsed time_window string,
 * e.g. "6am tomorrow", "tomorrow, 6am", "around 3:30", "7pm, 2 hours".
 * Returns null when the string has no clock time (e.g. just "morning"),
 * which the caller must treat as "cannot compare" — that's the (c)
 * upstream-format case, and it must be surfaced, not silently passed.
 */
export function parseTargetTime(
  timeWindow: string,
  now: Date = new Date()
): TargetTime | null {
  const tw = timeWindow.toLowerCase();

  // clock time: "6am", "6 am", "3:30", "7:15pm"
  const m = tw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3];

  // A bare number with no meridiem and no colon (e.g. the "2" in
  // "2 hours") is a duration, not a clock time — refuse to guess.
  if (!meridiem && !m[2]) return null;
  if (hour > 23 || minute > 59) return null;

  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  let day = now.getDay();
  if (tw.includes("tomorrow")) day = (day + 1) % 7;

  return { day, hour, minute };
}

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

function toWeekMinutes(p: HoursPoint): number {
  return p.day * MINUTES_PER_DAY + p.hour * 60 + p.minute;
}

/**
 * true  = open at target
 * false = closed at target
 * null  = no usable hours data (missing/malformed) — the (a) data case;
 *         the filter must decide policy for these, never coerce to false.
 */
export function isOpenAt(
  hours: CurrentOpeningHours | undefined | null,
  target: TargetTime
): boolean | null {
  const periods = hours?.periods;
  if (!Array.isArray(periods) || periods.length === 0) return null;

  const t = target.day * MINUTES_PER_DAY + target.hour * 60 + target.minute;

  for (const period of periods) {
    const open = period.open;
    if (!open || typeof open.day !== "number") return null; // malformed

    // 24/7: single period, no close.
    if (!period.close) {
      if (periods.length === 1) return true;
      continue; // malformed mixed data; other periods may still match
    }

    const o = toWeekMinutes(open);
    const c = toWeekMinutes(period.close);

    if (o === c) continue; // zero-length period, ignore
    if (o < c) {
      // same-week-segment window (possibly overnight within the week)
      if (t >= o && t < c) return true;
    } else {
      // wraps around the end of the week (e.g. Sat night → Sun morning)
      if (t >= o || t < c) return true;
    }
  }
  return false;
}
