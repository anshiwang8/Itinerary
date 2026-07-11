// Pure UI time/date labels. A rolled-forward stop (tomorrow's 10:30)
// must not read identically to today's, so any start that lands on a
// non-today calendar date carries a date prefix; same-day stays
// time-only. Decision is per-instant against a reference "now", so a
// schedule crossing midnight labels only the post-midnight stops.
// No scheduling logic here — display formatting only.
//
// EVERYTHING renders in the PLAN's own timezone (its resolved IANA zone,
// default America/Toronto), NEVER the viewer's browser zone and NEVER
// unconditionally Toronto:
//   - viewer's zone was the original Phase-1 bug (noon Toronto showed as
//     the viewer's midnight);
//   - always-Toronto was Phase 4's bug (a Vancouver plan showed Toronto
//     times). A Vancouver stop shows Vancouver's wall clock to every
//     viewer everywhere; a Toronto stop shows Toronto's.
// Callers pass the itinerary's zone; it defaults to Toronto so every
// pre-Phase-5 call site and all Toronto plans are byte-identical.
import { DateTime } from "luxon";
import { DEFAULT_ZONE, normalizeZone } from "./zoneTime";

type DateInput = Date | string;
const toDate = (x: DateInput): Date => (typeof x === "string" ? new Date(x) : x);

function zdt(d: Date, timeZone: string): DateTime {
  return DateTime.fromJSDate(d).setZone(normalizeZone(timeZone));
}

function timeOnly(d: Date, timeZone: string): string {
  // "7:00 PM" — byte-identical to the old toLocaleTimeString("en-US",
  // {hour:"numeric", minute:"2-digit"}) output (verified, incl. the space).
  return zdt(d, timeZone).toFormat("h:mm a");
}

// Whole calendar days from ref's zone-date to d's zone-date.
function dayOffset(d: Date, ref: Date, timeZone: string): number {
  const a = zdt(d, timeZone).startOf("day");
  const b = zdt(ref, timeZone).startOf("day");
  return Math.round(a.diff(b, "days").days);
}

// "Sat Jul 6" — weekday + month + day, no comma (matches the spec).
function shortDate(d: Date, timeZone: string): string {
  return zdt(d, timeZone).toFormat("ccc LLL d");
}

/**
 * Date prefix for a start instant relative to `ref` (default: real now),
 * both read in `timeZone`:
 *   today / past → ""            (time-only)
 *   +1 day       → "tomorrow, "
 *   further out  → "Sat Jul 6, "
 */
export function datePrefix(
  input: DateInput,
  ref: Date = new Date(),
  timeZone: string = DEFAULT_ZONE
): string {
  const off = dayOffset(toDate(input), ref, timeZone);
  if (off <= 0) return "";
  if (off === 1) return "tomorrow, ";
  return `${shortDate(toDate(input), timeZone)}, `;
}

/** Single labeled time (floor time, leave-home time): "tomorrow, 9:58 AM". */
export function formatStopTime(
  input: DateInput,
  ref: Date = new Date(),
  timeZone: string = DEFAULT_ZONE
): string {
  return `${datePrefix(input, ref, timeZone)}${timeOnly(toDate(input), timeZone)}`;
}

/**
 * "be here" range. The prefix keys off the START only — a stop that
 * merely straddles midnight (starts today, ends after 12) stays
 * today-labeled; the NEXT stop, starting post-midnight, is the one that
 * shows "tomorrow".
 *   today  → "7:00 PM – 8:45 PM"
 *   rolled → "tomorrow, 10:30 AM – 11:45 AM"
 */
export function formatStopRange(
  startInput: DateInput,
  endInput: DateInput,
  ref: Date = new Date(),
  timeZone: string = DEFAULT_ZONE
): string {
  return `${datePrefix(startInput, ref, timeZone)}${timeOnly(toDate(startInput), timeZone)} – ${timeOnly(
    toDate(endInput),
    timeZone
  )}`;
}
