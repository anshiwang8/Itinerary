// Zone-aware time primitives — the single place luxon + tz-lookup are
// wrapped, so the rest of the pipeline never hand-rolls Intl.DateTimeFormat
// parsing again (that ad-hoc arithmetic caused multiple TZ/meridiem bugs
// earlier in this project). Every plan carries ONE resolved IANA zone; all
// scheduling math and every display label render against THAT zone, not the
// server's and not the viewer's.
import { DateTime } from "luxon";
import tzlookup from "tz-lookup";

/** The prototype's original anchor — the default when a plan has no city,
 *  an unresolvable city, or is pre-multi-city (Toronto plans, all tests). */
export const DEFAULT_ZONE = "America/Toronto";

/** lat/lng → IANA zone via an OFFLINE lookup (tz-lookup, ~150KB, no API
 *  key, fits Vercel serverless). Never throws — bad coords fall back to
 *  the default zone so a zone lookup can't block a whole plan. */
export function zoneFromLatLng(lat: number, lng: number): string {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return DEFAULT_ZONE;
    return tzlookup(lat, lng);
  } catch {
    return DEFAULT_ZONE;
  }
}

/** A known IANA zone name, else the default (guards persisted/user data). */
export function normalizeZone(timeZone: string | undefined | null): string {
  if (!timeZone) return DEFAULT_ZONE;
  return DateTime.now().setZone(timeZone).isValid ? timeZone : DEFAULT_ZONE;
}

/**
 * Format an absolute instant as an ISO string in `timeZone`. Byte-identical
 * to the old hand-rolled toTorontoISO for America/Toronto across DST
 * (verified: "2026-07-03T19:00:00-04:00"), so Toronto output is unchanged.
 */
export function toZonedISO(d: Date, timeZone: string = DEFAULT_ZONE): string {
  return (
    DateTime.fromJSDate(d).setZone(normalizeZone(timeZone)).toISO({
      suppressMilliseconds: true,
    }) ?? d.toISOString()
  );
}

/** The zone's wall-clock components of an instant. weekday is 0=Sun..6=Sat
 *  (JS getDay / Google opening-hours convention), NOT luxon's 1=Mon..7=Sun. */
export function wallClockParts(
  instant: Date,
  timeZone: string = DEFAULT_ZONE
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const dt = DateTime.fromJSDate(instant).setZone(normalizeZone(timeZone));
  return {
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
    weekday: dt.weekday % 7, // luxon 7=Sun → 0; 1..6 unchanged
  };
}

/** Next full hour from `now`, measured in `timeZone` (e.g. 3:20 → 4:00
 *  local). No roll-forward — this is the "immediate" anchor. */
export function nextFullHourInZone(now: Date, timeZone: string = DEFAULT_ZONE): Date {
  return DateTime.fromJSDate(now)
    .setZone(normalizeZone(timeZone))
    .startOf("hour")
    .plus({ hours: 1 })
    .toJSDate();
}

/**
 * Build an absolute instant at a wall-clock hour:minute in `timeZone`, on
 * `now`'s local date shifted by `dayOffset` days. When `rollForward` and
 * the result is at/before `now`, bump one local day (DST-safe) — a plan
 * time that already passed means its next occurrence.
 */
export function instantAtWallClock(
  now: Date,
  timeZone: string,
  hour: number,
  minute: number,
  dayOffset: number = 0,
  rollForward: boolean = false
): Date {
  const zone = normalizeZone(timeZone);
  let dt = DateTime.fromJSDate(now)
    .setZone(zone)
    .plus({ days: dayOffset })
    .set({ hour, minute, second: 0, millisecond: 0 });
  if (rollForward && dt.toMillis() <= now.getTime()) dt = dt.plus({ days: 1 });
  return dt.toJSDate();
}
