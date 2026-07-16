// Pure stop-time scheduling (step 6a). Travel legs are a placeholder —
// the Routes API step inserts real travel time later.
//
// ZONE-AWARE: every plan carries one resolved IANA timeZone (default
// America/Toronto). "now", "today", "which hour" and the ISO output are
// all computed in THAT zone via app/lib/zoneTime — never the server's
// wall clock. Toronto plans are byte-identical to the pre-Phase-5 code.
import { parseTargetTime } from "../places/search/hours";
import { getDuration } from "./durations";
import { TravelLeg } from "./travel";
import {
  DEFAULT_ZONE,
  instantAtWallClock,
  nextFullHourInZone,
  toZonedISO as toZonedISOImpl,
  wallClockParts,
} from "../../lib/zoneTime";

// Day-part → representative default start, applied IN CODE when
// time_window has no clock time. Closes the "tonight parses to nothing"
// gap without touching the LLM prompt.
export const DAY_PART_DEFAULTS: Record<string, { hour: number; minute: number }> = {
  morning: { hour: 10, minute: 0 },
  afternoon: { hour: 14, minute: 0 },
  evening: { hour: 19, minute: 0 },
  tonight: { hour: 20, minute: 0 },
  night: { hour: 20, minute: 0 },
};

// Category → sensible default start when NEITHER a clock time NOR a
// day-part is given ("brunch downtown" shouldn't book at 3 AM).
// Ordered: specific rules before broad ones ("comedy club" is a show
// at 20:00, not a club at 22:00). No match → next full hour.
export const CATEGORY_START_DEFAULTS: Array<
  [RegExp, { hour: number; minute: number }]
> = [
  [/brunch/i, { hour: 10, minute: 30 }],
  [/breakfast/i, { hour: 9, minute: 0 }],
  [/lunch/i, { hour: 12, minute: 0 }],
  [/coffee|caf[eé]|espresso|matcha/i, { hour: 10, minute: 0 }],
  [/ice\s*cream|gelato/i, { hour: 15, minute: 0 }],
  [/dessert/i, { hour: 20, minute: 0 }], // typically post-dinner
  [/comedy|show|theatre|theater|concert/i, { hour: 20, minute: 0 }],
  [/club/i, { hour: 22, minute: 0 }],
  [/\bbars?\b|cocktail|pub|brewery|wine|drink/i, { hour: 20, minute: 0 }],
  [
    // cuisine words cover the ramen/late-night-food cases too
    /dinner|restaurant|dining|ramen|sushi|pizza|taco|noodle|pho|steak|izakaya|bbq/i,
    { hour: 19, minute: 0 },
  ],
];

function inferCategoryStart(
  category: string | undefined
): { hour: number; minute: number } | null {
  if (!category) return null;
  for (const [pattern, t] of CATEGORY_START_DEFAULTS) {
    if (pattern.test(category)) return t;
  }
  return null;
}

// Plausible start bands per category — the fail-loud guard for resolved
// times that carry no user time info. endHour < startHour wraps past
// midnight (bars, clubs).
export interface PlausibleBand {
  startHour: number;
  endHour: number;
}
export const PLAUSIBLE_BANDS: Array<[RegExp, PlausibleBand]> = [
  // parks are a daylight-hours activity with no "typical" start — they
  // keep the immediate next-full-hour anchor, but get a dawn-to-dusk band
  // so a 6 AM bench-sit passes and a midnight one honestly refuses
  [/park|garden|trail|stroll|hike|beach|\bwalk\b/i, { startHour: 6, endHour: 22 }],
  [/brunch/i, { startHour: 8, endHour: 15 }],
  [/breakfast/i, { startHour: 6, endHour: 12 }],
  [/lunch/i, { startHour: 11, endHour: 16 }],
  [/coffee|caf[eé]|espresso|matcha/i, { startHour: 7, endHour: 22 }],
  [/ice\s*cream|gelato/i, { startHour: 10, endHour: 23 }],
  [/dessert/i, { startHour: 10, endHour: 24 }],
  [/comedy|show|theatre|theater|concert/i, { startHour: 12, endHour: 24 }],
  [/club/i, { startHour: 20, endHour: 4 }],
  [/\bbars?\b|cocktail|pub|brewery|wine|drink/i, { startHour: 11, endHour: 2 }],
  [
    /dinner|restaurant|dining|ramen|sushi|pizza|taco|noodle|pho|steak|izakaya|bbq/i,
    { startHour: 11, endHour: 23 },
  ],
];
// The fallback band — used ONLY when no category matches a band above:
// an unrecognized category ("axe throwing") or a general/vague request
// with no category at all. It wraps past midnight to 1 AM because "some-
// thing to do" in a city genuinely runs late (bars, clubs, late food are
// open at 11 PM), and the immediate "now" slot rounds UP to the next full
// hour — an 8–23 band refused a 10:18 PM vague prompt purely on rounding.
// Recognized categories keep their OWN bands untouched, so explicit
// impossible requests ("brunch at 3am") still fail loud exactly as before.
export const DEFAULT_PLAUSIBLE_BAND: PlausibleBand = { startHour: 8, endHour: 1 };

// The band check reads the WALL-CLOCK hour in the plan's zone — a 7 PM
// Vancouver dinner must be judged against 19:00 Pacific, not the server's
// or Toronto's hour for that same instant.
function inBand(d: Date, band: PlausibleBand, timeZone: string = DEFAULT_ZONE): boolean {
  const { hour, minute } = wallClockParts(d, timeZone);
  const h = hour + minute / 60;
  if (band.startHour <= band.endHour) return h >= band.startHour && h < band.endHour;
  return h >= band.startHour || h < band.endHour; // wraps midnight
}

/** The plausible-hours band for a set of categories (first match wins). */
export function bandForCategories(categories: string[]): PlausibleBand {
  for (const c of categories) {
    const b = PLAUSIBLE_BANDS.find(([p]) => p.test(c))?.[1];
    if (b) return b;
  }
  return DEFAULT_PLAUSIBLE_BAND;
}

/** Is `d` a sensible hour for these categories, in the plan's zone? Reused
 * by the swap engine to reject implausible time changes ("dinner at 4am"). */
export function isPlausibleAt(
  d: Date,
  categories: string[],
  timeZone: string = DEFAULT_ZONE
): boolean {
  return inBand(d, bandForCategories(categories), timeZone);
}

export type StartResolution =
  | { ok: true; start: Date }
  | { ok: false; reason: string };

export const IMPLAUSIBLE_TIME_MESSAGE =
  "Couldn't find a sensible time for this — add one, like “dinner at 7pm”.";

function hour12(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  return `${hh % 12 || 12} ${hh < 12 ? "AM" : "PM"}`;
}

function clock12(d: Date, timeZone: string = DEFAULT_ZONE): string {
  const { hour, minute } = wallClockParts(d, timeZone);
  const num = `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""}`;
  return `${num} ${hour < 12 ? "AM" : "PM"}`;
}

// User asked for an hour nothing plausibly serves ("brunch at 3am") —
// name the category, its realistic window, and which direction to move.
function implausibleExplicitReason(
  start: Date,
  categories: string[],
  timeZone: string = DEFAULT_ZONE
): string {
  let label: string | null = null;
  let band = DEFAULT_PLAUSIBLE_BAND;
  for (const c of categories) {
    const hit = PLAUSIBLE_BANDS.find(([p]) => p.test(c));
    if (hit) {
      label = c;
      band = hit[1];
      break;
    }
  }
  const { hour, minute } = wallClockParts(start, timeZone);
  const h = hour + minute / 60;
  // outside a non-wrapping band: before open → later; past close → earlier.
  // A wrapped band's dead zone always sits before that day's opening.
  const beforeOpen = band.startHour <= band.endHour ? h < band.startHour : true;
  const suggest = beforeOpen ? "Try a later time?" : "Try an earlier time?";
  if (!label) {
    return `Couldn't plan that for ${clock12(start, timeZone)} — nothing much is open then. Try a time between ${hour12(band.startHour)} and ${hour12(band.endHour)}?`;
  }
  return `Couldn't plan a ${clock12(start, timeZone)} ${label} — ${label} around here runs about ${hour12(band.startHour)} to ${hour12(band.endHour)}. ${suggest}`;
}

// The user gave NO time and the resolver's own inferred slot (next full
// hour / category default) landed outside a KNOWN category's band — e.g.
// "sit in a park" at 10:54 PM resolves to 11 PM, past the park band's
// 10 PM close. "Add a time" is misleading here: nothing they type fixes
// tonight. Name the real obstacle and the realistic ways out. Returns
// null when no category has a band (nothing specific to say → the caller
// keeps the generic add-a-time message).
function implausibleInferredReason(
  start: Date,
  categories: string[],
  timeZone: string = DEFAULT_ZONE
): string | null {
  for (const c of categories) {
    const hit = PLAUSIBLE_BANDS.find(([p]) => p.test(c));
    if (!hit) continue;
    const band = hit[1];
    const { hour, minute } = wallClockParts(start, timeZone);
    const h = hour + minute / 60;
    const beforeOpen = band.startHour <= band.endHour ? h < band.startHour : true;
    const window = `${c} around here runs about ${hour12(band.startHour)} to ${hour12(band.endHour)}`;
    return beforeOpen
      ? `It's ${clock12(start, timeZone)} — too early for ${c} (${window}). Try later today?`
      : `It's ${clock12(start, timeZone)} — too late for ${c} today (${window}). Try tomorrow, or something else tonight?`;
  }
  return null;
}

/**
 * resolveStartTime + the fail-loud plausibility check. EVERY resolved
 * start must land inside a plausible band for at least one category
 * (generic 8–23 band when nothing matches). An explicit clock time or
 * day-part that lands outside every band ("brunch at 3am") fails with a
 * specific message naming the category's realistic window; an inferred
 * start (category default / next-full-hour) outside every band fails
 * with the generic add-a-time message.
 */
export function resolveStartTimeChecked(
  timeWindow: string,
  now: Date = new Date(),
  categories: string[] = [],
  timeZone: string = DEFAULT_ZONE
): StartResolution {
  const start = resolveStartTime(timeWindow, now, categories, timeZone);
  const tw = (timeWindow ?? "").toLowerCase();

  const bands = categories
    .map((c) => PLAUSIBLE_BANDS.find(([p]) => p.test(c))?.[1])
    .filter((b): b is PlausibleBand => !!b);
  if (bands.length === 0) bands.push(DEFAULT_PLAUSIBLE_BAND);
  if (bands.some((b) => inBand(start, b, timeZone))) return { ok: true, start };

  const hasClockTime = parseTargetTime(tw, now) !== null;
  const hasDayPart = Object.keys(DAY_PART_DEFAULTS).some((k) => tw.includes(k));
  // an explicit "now" (clarify answer) is a stated time too — a 3 AM
  // refusal must say "nothing's open then", never "add a time" (they just did)
  const hasExplicitNow = /\bnow\b/.test(tw);
  if (hasClockTime || hasDayPart || hasExplicitNow) {
    return { ok: false, reason: implausibleExplicitReason(start, categories, timeZone) };
  }
  // no stated time: if the category itself has a known window, say THAT
  // (adding a time wouldn't help); otherwise fall back to add-a-time
  return {
    ok: false,
    reason: implausibleInferredReason(start, categories, timeZone) ?? IMPLAUSIBLE_TIME_MESSAGE,
  };
}

/** Format an absolute instant as an ISO string in `timeZone` (default
 *  America/Toronto). Byte-identical to the old hand-rolled Toronto
 *  formatter for the default zone across DST. */
export function toZonedISO(d: Date, timeZone: string = DEFAULT_ZONE): string {
  return toZonedISOImpl(d, timeZone);
}

/** Toronto-zoned ISO — the pre-Phase-5 name, kept for callers that don't
 *  (yet) thread a plan zone. Equivalent to toZonedISO(d, DEFAULT_ZONE). */
export function toTorontoISO(d: Date): string {
  return toZonedISOImpl(d, DEFAULT_ZONE);
}

/**
 * Resolve time_window to a concrete start Date. This is the single
 * source of truth for "when does the outing start" — the hours filter,
 * weather gate, and schedule all call it so they agree on one instant.
 * 1. Clock time present → parseTargetTime (day-of-week aware).
 * 2. Day-part keyword → DAY_PART_DEFAULTS (respecting "tomorrow").
 * 3. Neither → infer from categories: earliest table default among the
 *    categories that match (anchor).
 * 4. No category matches either → next full hour from now.
 */
export function resolveStartTime(
  timeWindow: string,
  now: Date = new Date(),
  categories: string[] = [],
  timeZone: string = DEFAULT_ZONE
): Date {
  const tw = (timeWindow ?? "").toLowerCase();
  // "tomorrow" shifts one local day; the clock branch's daysAhead is only
  // ever 0/1 (parseTargetTime has no weekday names), so this single offset
  // captures every branch's day math — computed in the PLAN's zone.
  const dayOffset = tw.includes("tomorrow") ? 1 : 0;

  // explicit "now" (a clarify answer, or user phrasing like "right now")
  // → the immediate slot: next full hour, ignoring category defaults
  if (/\bnow\b/.test(tw)) {
    return nextFullHourInZone(now, timeZone);
  }

  const target = parseTargetTime(tw, now);
  if (target) {
    return instantAtWallClock(now, timeZone, target.hour, target.minute, dayOffset, true);
  }

  for (const [keyword, t] of Object.entries(DAY_PART_DEFAULTS)) {
    if (tw.includes(keyword)) {
      return instantAtWallClock(now, timeZone, t.hour, t.minute, dayOffset, true);
    }
  }

  // No clock time, no day-part → infer from the categories. Anchor on
  // the EARLIEST default among the categories that match the table —
  // not blindly the first category ("dessert then dinner" must anchor
  // on dinner's 19:00, not wipe every pool at next-full-hour because
  // the first category alone decided). No match at all → fall through.
  let inferred: { hour: number; minute: number } | null = null;
  for (const c of categories) {
    if (typeof c !== "string" || !c.trim()) continue;
    const t = inferCategoryStart(c);
    if (t && (!inferred || t.hour * 60 + t.minute < inferred.hour * 60 + inferred.minute)) {
      inferred = t;
    }
  }
  if (inferred) {
    return instantAtWallClock(now, timeZone, inferred.hour, inferred.minute, dayOffset, true);
  }

  // unspecified → next full hour
  return nextFullHourInZone(now, timeZone);
}

export interface SelectionLike {
  category: string;
  id: string | null;
  name?: string;
  reason?: string;
  fallback?: boolean;
  rating?: number;
  /** venue price level — carried on the stop so the strip's dollar signs
   * survive swaps/reroutes (pools-only lookups go stale) */
  priceLevel?: string;
  /** one-line venue description (Places editorialSummary) */
  description?: string;
  /** venue coordinates — passthrough; the reroute engine needs them */
  location?: { latitude: number; longitude: number };
}

export interface ScheduledStop extends SelectionLike {
  start_time: string | null;
  end_time: string | null;
  durationMinutes: { base: number; buffer: number; total: number } | null;
  /** padded travel minutes to the next timed stop (0 when no leg data) */
  travelMinutesToNext?: number;
  /** full leg detail for the UI ("transit · 25 min incl. 5 min buffer") */
  travelToNext?: TravelLeg;
}

/**
 * Assign start/end times to ordered selections. Pure — travel legs are
 * fetched by the caller (Routes API) and passed in; travelLegs[k] is the
 * leg between the k-th and (k+1)-th TIMED stop. Omitted/missing legs
 * fall back to 0 travel. Null-id selections (empty pools) pass through
 * untimed. Times are ISO strings in America/Toronto.
 *
 * With a homeLeg (home → first stop), the resolved start is the
 * LEAVE-HOME time — startISO — and the first timed stop starts after
 * that leg's travel, mirroring how the reroute engine anchors a replan
 * at floor + inbound travel.
 */
export function buildSchedule(
  selections: SelectionLike[],
  timeWindow: string,
  now: Date = new Date(),
  travelLegs: TravelLeg[] = [],
  // reroute engine anchors the replanned chain at an explicit instant
  startOverride?: Date,
  homeLeg?: TravelLeg | null,
  // the plan's zone — stop ISO times render in it (default Toronto)
  timeZone: string = DEFAULT_ZONE
): { startISO: string; stops: ScheduledStop[] } {
  const iso = (d: Date) => toZonedISOImpl(d, timeZone);
  const start =
    startOverride ??
    resolveStartTime(timeWindow, now, selections.map((s) => s.category), timeZone);
  const cursor = new Date(start);
  if (homeLeg) cursor.setMinutes(cursor.getMinutes() + homeLeg.totalMinutes);

  const timed: ScheduledStop[] = [];
  let timedIndex = 0;
  for (const sel of selections) {
    if (sel.id === null) {
      timed.push({ ...sel, start_time: null, end_time: null, durationMinutes: null });
      continue;
    }
    const { baseMinutes, bufferMinutes } = getDuration(sel.category);
    const total = baseMinutes + bufferMinutes;
    const stopStart = new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() + total);

    const leg = travelLegs.find((l) => l.fromIndex === timedIndex);
    timed.push({
      ...sel,
      start_time: iso(stopStart),
      end_time: iso(cursor),
      durationMinutes: { base: baseMinutes, buffer: bufferMinutes, total },
      travelMinutesToNext: leg?.totalMinutes ?? 0,
      ...(leg ? { travelToNext: leg } : {}),
    });
    // next stop starts after the travel leg (0 when no leg data)
    cursor.setMinutes(cursor.getMinutes() + (leg?.totalMinutes ?? 0));
    timedIndex++;
  }

  // last timed stop has no next leg
  for (let i = timed.length - 1; i >= 0; i--) {
    if (timed[i].id !== null) {
      delete timed[i].travelMinutesToNext;
      delete timed[i].travelToNext;
      break;
    }
  }

  return { startISO: iso(start), stops: timed };
}
