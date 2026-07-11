// Pure UI time/date labels. A rolled-forward stop (tomorrow's 10:30)
// must not read identically to today's, so any start that lands on a
// non-today calendar date carries a date prefix; same-day stays
// time-only. Decision is per-instant against a reference "now", so a
// schedule crossing midnight labels only the post-midnight stops.
// No scheduling logic here — display formatting only.
//
// EVERYTHING renders in the plan's home timezone (America/Toronto),
// NEVER the viewer's. The itinerary is a Toronto evening; a viewer in a
// UTC+8 browser must still read "12:00 PM", not their local "12:00 AM"
// (that exact off-by-a-timezone rendering shipped as the
// midnight-itinerary-for-lunch bug).
const HOME_TZ = "America/Toronto";

type DateInput = Date | string;
const toDate = (x: DateInput): Date => (typeof x === "string" ? new Date(x) : x);

const dayPartsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: HOME_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// The instant's calendar day IN HOME_TZ, as a comparable UTC-ms value.
function calendarDay(d: Date): number {
  const p = Object.fromEntries(dayPartsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
}

function timeOnly(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: HOME_TZ,
  });
}

// Whole calendar days from ref's HOME_TZ date to d's HOME_TZ date.
function dayOffset(d: Date, ref: Date): number {
  return Math.round((calendarDay(d) - calendarDay(ref)) / 86_400_000);
}

// "Sat Jul 6" — weekday + month + day, no comma (matches the spec).
function shortDate(d: Date): string {
  const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: HOME_TZ });
  const mo = d.toLocaleDateString("en-US", { month: "short", timeZone: HOME_TZ });
  const p = Object.fromEntries(dayPartsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${wd} ${mo} ${Number(p.day)}`;
}

/**
 * Date prefix for a start instant relative to `ref` (default: real now):
 *   today / past → ""            (time-only)
 *   +1 day       → "tomorrow, "
 *   further out  → "Sat Jul 6, "
 */
export function datePrefix(input: DateInput, ref: Date = new Date()): string {
  const off = dayOffset(toDate(input), ref);
  if (off <= 0) return "";
  if (off === 1) return "tomorrow, ";
  return `${shortDate(toDate(input))}, `;
}

/** Single labeled time (floor time, leave-home time): "tomorrow, 9:58 AM". */
export function formatStopTime(input: DateInput, ref: Date = new Date()): string {
  return `${datePrefix(input, ref)}${timeOnly(toDate(input))}`;
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
  ref: Date = new Date()
): string {
  return `${datePrefix(startInput, ref)}${timeOnly(toDate(startInput))} – ${timeOnly(
    toDate(endInput)
  )}`;
}
