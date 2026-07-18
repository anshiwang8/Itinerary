// "Is this venue open at time X" — THE single openness check for the whole
// pipeline. `isOpenAtInstant` (zone-aware, below) is the entry point every
// caller should use; `isOpenAt` is the pure day/hour comparison underneath.
// Previously the instant→wall-clock conversion was reimplemented at three
// call sites, two of them using the SERVER's clock — see code-audit
// 2026-07-18 §1.1/§1.3/§5.2.
//
// Google's currentOpeningHours.periods entries look like:
//   { open:  { day: 0-6, hour, minute, date? },
//     close: { day: 0-6, hour, minute, date? } }
// day 0 = Sunday. A 24/7 venue is a single period with open day 0,
// hour 0 and no close. Overnight periods have close.day != open.day.
import { DEFAULT_ZONE, wallClockParts } from "../../../lib/zoneTime";

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

/** A wall-clock time with no date attached — what a time_window string can
 *  actually tell us. Deliberately NOT a TargetTime: which DAY a stated hour
 *  falls on is the resolver's job (it owns "tomorrow" and roll-forward), and
 *  a day computed here could only ever come from the server's clock. */
export interface ClockTime {
  hour: number;
  minute: number;
}

/**
 * Extract a comparable clock time from a parsed time_window string,
 * e.g. "6am tomorrow", "tomorrow, 6am", "around 3:30", "7pm, 2 hours".
 * Returns null when the string has no clock time (e.g. just "morning"),
 * which the caller must treat as "cannot compare" — that's the (c)
 * upstream-format case, and it must be surfaced, not silently passed.
 */
export function parseTargetTime(timeWindow: string): ClockTime | null {
  const tw = timeWindow.toLowerCase();

  // clock time: "6am", "6 am", "3:30", "7:15pm". Scan ALL numeric candidates
  // and take the first REAL clock time — a leading bare number is usually a
  // duration ("2 hours, 7pm"), and bailing on it silently dropped the stated
  // time. A bare number with no meridiem and no colon is never a clock time.
  const candidates = tw.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g);
  for (const m of candidates) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const meridiem = m[3];

    if (!meridiem && !m[2]) continue; // bare number → duration, keep looking
    if (hour > 23 || minute > 59) continue;

    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    return { hour, minute };
  }
  return null;
}

/**
 * THE conversion from an absolute instant to a venue-local TargetTime.
 * Day-of-week AND hour are read on the VENUE's own wall clock (the plan's
 * zone), never the server's — a city far enough from the server's offset is
 * a different weekday at the same instant, which would silently compare
 * against the wrong day's opening hours.
 */
export function targetTimeAt(
  instant: Date,
  timeZone: string = DEFAULT_ZONE
): TargetTime {
  const { weekday, hour, minute } = wallClockParts(instant, timeZone);
  return { day: weekday, hour, minute };
}

/**
 * "Is this venue open at this absolute instant?" — the ONE zone-aware
 * openness check. Every caller that has an instant (the objective filter,
 * the swap engine's availability seam, the mock fixture layer) goes through
 * here, so the zone handling can never diverge between them again.
 * Same tri-state contract as isOpenAt: null = no usable data (keep).
 */
export function isOpenAtInstant(
  hours: CurrentOpeningHours | undefined | null,
  instant: Date,
  timeZone: string = DEFAULT_ZONE
): boolean | null {
  return isOpenAt(hours, targetTimeAt(instant, timeZone));
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
