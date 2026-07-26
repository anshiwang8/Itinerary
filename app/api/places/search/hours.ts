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

export type ClockParseResult =
  | { kind: "none" }
  | { kind: "valid"; time: ClockTime }
  | { kind: "invalid"; value: string };

/**
 * Extract a comparable clock time from a parsed time_window string,
 * e.g. "6am tomorrow", "tomorrow, 6am", "around 3:30", "7pm, 2 hours".
 * Returns null when the string has no clock time (e.g. just "morning"),
 * which the caller must treat as "cannot compare" — that's the (c)
 * upstream-format case, and it must be surfaced, not silently passed.
 */
export function parseClockTime(timeWindow: string): ClockParseResult {
  const tw = timeWindow.toLowerCase();

  // A sign is never meaningful on a wall-clock hour. Check it before the
  // unsigned scanners below, which would otherwise read "-1pm" as "1pm".
  // Duration deltas such as "-1 hours" remain non-clock input.
  const signedClock =
    tw.match(/(?:^|[\s,(])([+-]\s*\d+(?::\s*\d+)?\s*(?:am|pm))\b/) ??
    tw.match(/(?:^|[\s,(])([+-]\s*\d+:\s*\d+)\b/) ??
    tw.match(/\b(?:at|around|by|after|before)\s+([+-]\s*\d+)\b(?!\s*(?:hours?|minutes?))/) ??
    tw.match(/^\s*([+-]\s*\d+)\s*$/) ??
    tw.match(/\b(\d+:\s*[+-]\s*\d+)\b/);
  if (signedClock) {
    return { kind: "invalid", value: signedClock[1] };
  }

  // Meridiem clocks. The 12-hour domain is strict: 00pm and 13pm are
  // invalid, never values to coerce or skip over.
  const meridiemCandidates = [
    ...tw.matchAll(/\b(\d+)(?::(\d+))?\s*(am|pm)\b/g),
  ];
  let meridiemTime: ClockTime | null = null;
  for (const match of meridiemCandidates) {
    let hour = Number(match[1]);
    const minuteText = match[2];
    const minute = minuteText === undefined ? 0 : Number(minuteText);
    if (
      match[1].length > 2 ||
      hour < 1 ||
      hour > 12 ||
      (minuteText !== undefined && minuteText.length !== 2) ||
      minute < 0 ||
      minute > 59
    ) {
      return { kind: "invalid", value: match[0] };
    }
    if (match[3] === "pm" && hour !== 12) hour += 12;
    if (match[3] === "am" && hour === 12) hour = 0;
    meridiemTime ??= { hour, minute };
  }

  // 24-hour clocks require a colon. Bare numbers are clocks only when the
  // whole value is numeric or a clock preposition owns them; "5 hours"
  // remains a duration.
  const colonCandidates = [...tw.matchAll(/\b(\d+):(\d+)\b/g)];
  let colonTime: ClockTime | null = null;
  for (const colon of colonCandidates) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (colon[1].length > 2 || colon[2].length !== 2 || hour > 23 || minute > 59) {
      return { kind: "invalid", value: colon[0] };
    }
    colonTime ??= { hour, minute };
  }
  if (meridiemTime) return { kind: "valid", time: meridiemTime };
  if (colonTime) return { kind: "valid", time: colonTime };

  const bare =
    tw.match(/^\s*(\d+)\s*$/) ??
    tw.match(/\b(?:at|around|by|after|before)\s+(\d+)\b(?!\s*(?:hours?|minutes?))/);
  if (bare) {
    const hour = Number(bare[1]);
    if (bare[1].length > 2 || hour > 23) {
      return { kind: "invalid", value: bare[0].trim() };
    }
    return { kind: "valid", time: { hour, minute: 0 } };
  }
  return { kind: "none" };
}

export function parseTargetTime(timeWindow: string): ClockTime | null {
  const result = parseClockTime(timeWindow);
  return result.kind === "valid" ? result.time : null;
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

function toWeekMinutes(p: HoursPoint): number {
  return p.day * MINUTES_PER_DAY + p.hour * 60 + p.minute;
}

function validHoursPoint(value: HoursPoint | undefined): value is HoursPoint {
  return !!(
    value &&
    Number.isInteger(value.day) &&
    value.day >= 0 &&
    value.day <= 6 &&
    Number.isInteger(value.hour) &&
    value.hour >= 0 &&
    value.hour <= 23 &&
    Number.isInteger(value.minute) &&
    value.minute >= 0 &&
    value.minute <= 59
  );
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

  let inconclusive = false;
  for (const period of periods) {
    if (!period || typeof period !== "object") {
      inconclusive = true;
      continue;
    }
    const open = period.open;
    if (!validHoursPoint(open)) {
      inconclusive = true;
      continue;
    }

    // Google's conclusive 24/7 shape: a single Sunday-midnight opening
    // with no close. Every other missing close is malformed.
    if (!period.close) {
      if (
        periods.length === 1 &&
        open.day === 0 &&
        open.hour === 0 &&
        open.minute === 0
      ) {
        return true;
      }
      inconclusive = true;
      continue;
    }
    if (!validHoursPoint(period.close)) {
      inconclusive = true;
      continue;
    }

    const o = toWeekMinutes(open);
    const c = toWeekMinutes(period.close);

    if (o === c) {
      inconclusive = true;
      continue;
    }
    if (o < c) {
      // same-week-segment window (possibly overnight within the week)
      if (t >= o && t < c) return true;
    } else {
      // wraps around the end of the week (e.g. Sat night → Sun morning)
      if (t >= o || t < c) return true;
    }
  }
  return inconclusive ? null : false;
}
