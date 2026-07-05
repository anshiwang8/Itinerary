// Pure UI time/date labels. A rolled-forward stop (tomorrow's 10:30)
// must not read identically to today's, so any start that lands on a
// non-today calendar date carries a date prefix; same-day stays
// time-only. Decision is per-instant against a reference "now", so a
// schedule crossing midnight labels only the post-midnight stops.
// No scheduling logic here — display formatting only.

type DateInput = Date | string;
const toDate = (x: DateInput): Date => (typeof x === "string" ? new Date(x) : x);

function timeOnly(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Whole calendar days from ref's local date to d's local date.
function dayOffset(d: Date, ref: Date): number {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
  return Math.round((a - b) / 86_400_000);
}

// "Sat Jul 6" — weekday + month + day, no comma (matches the spec).
function shortDate(d: Date): string {
  const wd = d.toLocaleDateString("en-US", { weekday: "short" });
  const mo = d.toLocaleDateString("en-US", { month: "short" });
  return `${wd} ${mo} ${d.getDate()}`;
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
