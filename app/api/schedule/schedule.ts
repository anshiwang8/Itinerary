// Pure stop-time scheduling (step 6a). Travel legs are a placeholder —
// the Routes API step inserts real travel time later.
//
// ZONE-AWARE: every plan carries one resolved IANA timeZone (default
// America/Toronto). "now", "today", "which hour" and the ISO output are
// all computed in THAT zone via app/lib/zoneTime — never the server's
// wall clock. Toronto plans are byte-identical to the pre-Phase-5 code.
import { CurrentOpeningHours, parseClockTime } from "../places/search/hours";
import { getDuration } from "./durations";
import { TravelLeg } from "./travel";
import {
  DEFAULT_ZONE,
  instantAtLocalDateTime,
  localDateAfterDays,
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
  // An all-day ask ("a full schedule", "the whole day" — the parse
  // captures these as exactly "all day") kicks off late morning. 11:00,
  // not 10:00, deliberately: a themed full day usually carries a food
  // facet ("sports bar", "restaurant"), and those bands open at 11 —
  // a 10:00 start would fail the plausibility check for exactly the
  // multi-facet plans this anchor exists for, while 11:00 sits on the
  // food bands' opening edge and still leaves a full day ahead. Without
  // this entry, "a full day as a soccer fan" anchored on the FOOD
  // facet's 19:00 category default — an evening start for a day plan,
  // with the museum stop arriving after close. Listed last: specific
  // day-parts win when both appear ("tomorrow night, all day out").
  "all day": { hour: 11, minute: 0 },
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

// ── the plausibility gate is GONE (2026-07-27) ───────────────────────────
// PLAUSIBLE_BANDS / isPlausibleAt / bandForCategories / the two implausible-
// reason builders / StartResolution's `overridable` + `category` all existed
// to refuse times a hardcoded table considered unreasonable. They are
// removed on purpose.
//
// "Nothing's open at 3am" is a FACT — the objective hours filter decides it
// on real Places data, per venue, at the resolved instant. "Brunch isn't
// plausible at 3am" was an OPINION, and a wrong one whenever a 24/7 diner is
// around the corner. This layer was guessing where evidence is available,
// which is exactly the habit the planner change removes. An impossible hour
// now surfaces as what it really is: every pool emptied on `hours`, which
// noVenuesReason already reports honestly ("everything nearby is closed at
// that hour").
//
// The one behaviour that had to SURVIVE the deletion is the swap engine's
// meridiem disambiguation ("make it 10" on a brunch stop means 10 AM, not
// 10 PM). That is a reading-comprehension judgment about an ambiguous
// number, not a refusal, so it kept a minimal category→rough-hours map of
// its own in swap.ts — see ROUGH_HOURS there.

/**
 * Resolve a time_window to a start instant, without any plausibility
 * judgment. Malformed input (an unparseable clock, a contradictory calendar
 * qualifier, a date that doesn't exist) still fails loud — those are facts
 * about the input, not opinions about the hour.
 */
export type StartResolution = { ok: true; start: Date } | { ok: false; reason: string };

export function resolveStartTimeChecked(
  timeWindow: string,
  now: Date = new Date(),
  categories: string[] = [],
  timeZone: string = DEFAULT_ZONE
): StartResolution {
  return resolveStartTimeResult(timeWindow, now, categories, timeZone);
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
 * 1. Clock time present → parseTargetTime (hour/minute only; which DAY that
 *    hour lands on is decided here, in the plan's zone, never by the parser).
 * 2. Day-part keyword → DAY_PART_DEFAULTS (respecting "tomorrow").
 * 3. Neither → infer from categories: earliest table default among the
 *    categories that match (anchor).
 * 4. No category matches either → next full hour from now.
 */
const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_NAME_PATTERN = Object.keys(MONTHS).join("|");
const NAMED_DATE_FORWARD = new RegExp(
  `\\b(${MONTH_NAME_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!\\w)`
);
const NAMED_DATE_REVERSE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME_PATTERN})(?:,?\\s+(\\d{4}))?(?!\\w)`
);

interface CalendarSpan {
  start: number;
  end: number;
}

type CalendarQualifier =
  | { kind: "none" }
  | ({ kind: "today" } & CalendarSpan)
  | ({ kind: "tomorrow" } & CalendarSpan)
  | ({ kind: "weekday"; weekday: number; next: boolean } & CalendarSpan)
  | ({ kind: "date"; year: number | null; month: number; day: number } & CalendarSpan)
  | { kind: "invalid"; reason: string };

function spanOf(match: RegExpMatchArray): CalendarSpan {
  const start = match.index ?? 0;
  return { start, end: start + match[0].length };
}

function isMalformedNamedDayToken(token: string): boolean {
  const looksDateLike =
    /^\d+$/.test(token) || /^\d+(?:st|nd|rd|th)/.test(token);
  return looksDateLike && !/^\d{1,2}(?:st|nd|rd|th)?$/.test(token);
}

function malformedCalendarReason(tw: string): string | null {
  // ISO-looking tokens must be complete dates. This catches partial matches
  // such as 2026-08-150 instead of letting the resolver silently discard them.
  for (const candidate of tw.matchAll(/\b\d{4}-[a-z0-9_+-]+/g)) {
    if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(candidate[0])) {
      return "Couldn't understand that calendar date. Use a date such as 2026-08-15 or August 15.";
    }
  }

  const validReverse = tw.match(NAMED_DATE_REVERSE);
  const forwardLike = new RegExp(
    `\\b(${MONTH_NAME_PATTERN})\\s+(\\d[^\\s,.;!?)]*)`,
    "g"
  );
  for (const candidate of tw.matchAll(forwardLike)) {
    const candidateStart = candidate.index ?? 0;
    const insideReverseDate =
      !!validReverse &&
      candidateStart >= (validReverse.index ?? 0) &&
      candidateStart < (validReverse.index ?? 0) + validReverse[0].length;
    if (insideReverseDate) continue;
    if (isMalformedNamedDayToken(candidate[2])) {
      return "Couldn't understand that calendar date. Use a date such as 2026-08-15 or August 15.";
    }
  }

  const reverseLike = new RegExp(
    `\\b(\\d[^\\s,.;!?(]*)\\s+(${MONTH_NAME_PATTERN})\\b`,
    "g"
  );
  for (const candidate of tw.matchAll(reverseLike)) {
    if (isMalformedNamedDayToken(candidate[1])) {
      return "Couldn't understand that calendar date. Use a date such as 2026-08-15 or August 15.";
    }
  }
  return null;
}

function calendarQualifier(timeWindow: string): CalendarQualifier {
  const tw = timeWindow.toLowerCase();
  const malformedReason = malformedCalendarReason(tw);
  if (malformedReason) return { kind: "invalid", reason: malformedReason };

  const iso = tw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})(?![\w-])/);
  const namedForward = tw.match(NAMED_DATE_FORWARD);
  const namedReverse = tw.match(NAMED_DATE_REVERSE);
  const weekday = tw.match(
    /\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/
  );
  const today = tw.match(/\btoday\b/);
  const tomorrow = tw.match(/\btomorrow\b/);
  const qualifierCount =
    Number(!!iso) +
    Number(!!namedForward) +
    Number(!!namedReverse) +
    Number(!!weekday) +
    Number(!!today) +
    Number(!!tomorrow);
  if (qualifierCount > 1) {
    return {
      kind: "invalid",
      reason: "That request has conflicting calendar dates. Choose one day.",
    };
  }
  if (iso) {
    return {
      kind: "date",
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      ...spanOf(iso),
    };
  }
  if (namedForward || namedReverse) {
    const month = namedForward?.[1] ?? namedReverse![2];
    const day = namedForward?.[2] ?? namedReverse![1];
    const year = namedForward?.[3] ?? namedReverse?.[3];
    return {
      kind: "date",
      year: year ? Number(year) : null,
      month: MONTHS[month],
      day: Number(day),
      ...spanOf(namedForward ?? namedReverse!),
    };
  }
  if (/\b\d+\s*\/\s*\d+/.test(tw)) {
    return {
      kind: "invalid",
      reason: "Use an unambiguous date such as 2026-08-15 or August 15.",
    };
  }
  if (weekday) {
    return {
      kind: "weekday",
      weekday: WEEKDAYS[weekday[2]],
      next: !!weekday[1],
      ...spanOf(weekday),
    };
  }
  if (today) return { kind: "today", ...spanOf(today) };
  if (tomorrow) return { kind: "tomorrow", ...spanOf(tomorrow) };
  return { kind: "none" };
}

type StartTimeResult =
  | { ok: true; start: Date }
  | { ok: false; reason: string };

function bareClockAfterCalendar(
  tw: string,
  qualifier: Exclude<CalendarQualifier, { kind: "invalid" }>
): ReturnType<typeof parseClockTime> {
  if (qualifier.kind === "none") return { kind: "none" };
  const suffix = tw.slice(qualifier.end);
  const candidate = suffix.match(/^\s*,?\s*(?:at\s+)?([+-]?\s*\d+)\s*$/);
  return candidate ? parseClockTime(candidate[1]) : { kind: "none" };
}

function resolvedClock(
  tw: string,
  categories: string[],
  qualifier: CalendarQualifier
): { hour: number; minute: number } | StartTimeResult {
  let clock = parseClockTime(tw);
  if (clock.kind === "none" && qualifier.kind !== "invalid") {
    clock = bareClockAfterCalendar(tw, qualifier);
  }
  if (clock.kind === "invalid") {
    return {
      ok: false,
      reason: `Couldn't understand the time "${clock.value}". Use a valid clock such as 7pm or 19:00.`,
    };
  }
  if (clock.kind === "valid") return clock.time;
  for (const [keyword, time] of Object.entries(DAY_PART_DEFAULTS)) {
    if (tw.includes(keyword)) return time;
  }
  let inferred: { hour: number; minute: number } | null = null;
  for (const category of categories) {
    if (typeof category !== "string" || !category.trim()) continue;
    const time = inferCategoryStart(category);
    if (
      time &&
      (!inferred || time.hour * 60 + time.minute < inferred.hour * 60 + inferred.minute)
    ) {
      inferred = time;
    }
  }
  if (inferred) return inferred;
  if (qualifier.kind !== "none" && qualifier.kind !== "today") {
    return DAY_PART_DEFAULTS.morning;
  }
  return { hour: -1, minute: -1 };
}

function resolveStartTimeResult(
  timeWindow: string,
  now: Date = new Date(),
  categories: string[] = [],
  timeZone: string = DEFAULT_ZONE
): StartTimeResult {
  const tw = (timeWindow ?? "").toLowerCase();

  // explicit "now" (a clarify answer, or user phrasing like "right now")
  // → the immediate slot: next full hour, ignoring category defaults
  if (/\bnow\b/.test(tw)) {
    return { ok: true, start: nextFullHourInZone(now, timeZone) };
  }

  const qualifier = calendarQualifier(tw);
  if (qualifier.kind === "invalid") return { ok: false, reason: qualifier.reason };
  const clock = resolvedClock(tw, categories, qualifier);
  if ("ok" in clock) return clock;
  if (clock.hour < 0) return { ok: true, start: nextFullHourInZone(now, timeZone) };

  const localNow = wallClockParts(now, timeZone);
  let dayOffset = 0;
  if (qualifier.kind === "tomorrow") dayOffset = 1;
  if (qualifier.kind === "weekday") {
    dayOffset = (qualifier.weekday - localNow.weekday + 7) % 7;
    if (qualifier.next && dayOffset === 0) dayOffset = 7;
  }
  let date =
    qualifier.kind === "date"
      ? {
          year: qualifier.year ?? localNow.year,
          month: qualifier.month,
          day: qualifier.day,
        }
      : localDateAfterDays(now, timeZone, dayOffset);
  let start = instantAtLocalDateTime(date, timeZone, clock.hour, clock.minute);
  if (!start) {
    return {
      ok: false,
      reason: "That date or local time doesn't exist. Choose another date or time.",
    };
  }

  if (qualifier.kind === "date" && qualifier.year === null && start.getTime() <= now.getTime()) {
    date = { ...date, year: date.year + 1 };
    start = instantAtLocalDateTime(date, timeZone, clock.hour, clock.minute);
    if (!start) {
      return {
        ok: false,
        reason: "That date or local time doesn't exist. Choose another date or time.",
      };
    }
  }

  if (qualifier.kind === "weekday" && dayOffset === 0 && start.getTime() <= now.getTime()) {
    date = localDateAfterDays(now, timeZone, 7);
    start = instantAtLocalDateTime(date, timeZone, clock.hour, clock.minute)!;
  } else if (
    (qualifier.kind === "none" || qualifier.kind === "today") &&
    start.getTime() <= now.getTime()
  ) {
    date = localDateAfterDays(now, timeZone, 1);
    start = instantAtLocalDateTime(date, timeZone, clock.hour, clock.minute)!;
  } else if (
    qualifier.kind === "date" &&
    qualifier.year !== null &&
    start.getTime() <= now.getTime()
  ) {
    return {
      ok: false,
      reason: "That date and time have already passed. Choose a future time.",
    };
  }
  return { ok: true, start };
}

export function resolveStartTime(
  timeWindow: string,
  now: Date = new Date(),
  categories: string[] = [],
  timeZone: string = DEFAULT_ZONE
): Date {
  const result = resolveStartTimeResult(timeWindow, now, categories, timeZone);
  if (!result.ok) {
    throw new RangeError(result.reason);
  }
  return result.start;
}

export interface SelectionLike {
  category: string;
  id: string | null;
  name?: string;
  reason?: string;
  fallback?: boolean;
  /** which requested stop this fills — two stops can share a category, so
   * the slot (not the category) is the identity (code-audit §7.1) */
  slot?: number;
  rating?: number;
  /** venue price level — carried on the stop so the strip's dollar signs
   * survive swaps/reroutes (pools-only lookups go stale) */
  priceLevel?: string;
  /** one-line venue description (Places editorialSummary) */
  description?: string;
  /** opening hours travel with the stop so a later availability check
   * doesn't need a pools lookup that has gone stale. Absent means Places
   * had no hours data — keep-on-missing, still usable. */
  currentOpeningHours?: CurrentOpeningHours;
  /** venue coordinates — passthrough; the reroute engine needs them */
  location?: { latitude: number; longitude: number };
  /** THE stop's own length in minutes, proposed by the planner and refined
   * against the venue that was actually picked. Absent means no LLM
   * estimate reached this stop (swap, reroute, recovery slots, legacy
   * stored plans) and DURATION_TABLE decides — exactly as it always did. */
  plannedMinutes?: number;
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

// ── window validation ────────────────────────────────────────────────────
//
// The planner PROPOSES how much fits between a stated start and end. Code
// decides, here, once the real travel legs are known — this is the concrete
// case the architecture rule names: if the planner says four activities fit
// between 3 and 8 and the real legs make it six hours, the LLM never gets to
// be wrong about it.

/**
 * How far past a stated end a plan may run before code intervenes.
 *
 * 30 minutes, deliberately generous. A stated window is a human's rough
 * intent ("3 to 8ish"), not a booking; the travel legs inside it already
 * carry their own delay margins; and stop durations are estimates on both
 * sides. Dropping a whole activity someone asked for — the only remedy
 * available — to recover fifteen minutes is a worse outcome than running
 * slightly over, so the tolerance sits where dropping starts to be the
 * lesser harm rather than at zero.
 */
export const WINDOW_OVERRUN_TOLERANCE_MINUTES = 30;

/**
 * A gap this large at the end of a stated window means the planner
 * UNDER-filled it. Code deliberately does not fill it (that would be a
 * second planning mechanism, in the wrong language); it is logged so the
 * shortfall is visible.
 */
export const WINDOW_UNDERFILL_LOG_MINUTES = 90;

export interface WindowFit {
  /** minutes the last timed stop's END runs past the stated end (0 if none) */
  overrunMinutes: number;
  /** within the tolerance — nothing to do */
  fits: boolean;
  /** how many LEADING timed stops finish inside the window + tolerance */
  keep: number;
  /** total timed stops considered */
  timed: number;
  /** unused minutes between the last kept stop's end and the window's end */
  unfilledMinutes: number;
}

/**
 * Does this schedule actually fit the stated window? Pure: takes the stops
 * as scheduled (real travel already folded into their times) and the stated
 * end. Returns null when there is no usable end to check against — an
 * unstated end is not a constraint, and code must not invent one.
 */
export function checkWindowFit(
  stops: ScheduledStop[],
  endISO: string | null | undefined,
  toleranceMinutes: number = WINDOW_OVERRUN_TOLERANCE_MINUTES
): WindowFit | null {
  if (!endISO) return null;
  const end = new Date(endISO).getTime();
  if (!Number.isFinite(end)) return null;

  const timed = stops.filter((s) => s.id !== null && s.end_time);
  if (timed.length === 0) return null;

  const limit = end + toleranceMinutes * 60_000;
  let keep = 0;
  let lastKeptEnd = 0;
  for (const stop of timed) {
    const stopEnd = new Date(stop.end_time!).getTime();
    if (!Number.isFinite(stopEnd) || stopEnd > limit) break;
    keep++;
    lastKeptEnd = stopEnd;
  }

  const finalEnd = new Date(timed[timed.length - 1].end_time!).getTime();
  const overrunMinutes = Number.isFinite(finalEnd)
    ? Math.max(0, Math.round((finalEnd - end) / 60_000))
    : 0;

  return {
    overrunMinutes,
    fits: keep === timed.length,
    keep,
    timed: timed.length,
    unfilledMinutes:
      keep > 0 ? Math.max(0, Math.round((end - lastKeptEnd) / 60_000)) : 0,
  };
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
  // Elapsed-time arithmetic on absolute instants. This was local-FIELD math
  // (`cursor.setMinutes(cursor.getMinutes() + n)`), which normalizes against
  // the SERVER's wall clock and therefore shifts by an hour across the
  // server's DST transition — in a function whose whole contract is per-plan
  // zone correctness. Stop durations are elapsed time, so milliseconds are
  // the correct unit (code-audit 2026-07-18 §1.6).
  let cursor = new Date(start);
  if (homeLeg) cursor = new Date(cursor.getTime() + homeLeg.totalMinutes * 60_000);

  const timed: ScheduledStop[] = [];
  let timedIndex = 0;
  for (const sel of selections) {
    if (sel.id === null) {
      timed.push({ ...sel, start_time: null, end_time: null, durationMinutes: null });
      continue;
    }
    // The stop's OWN duration wins when it has one; DURATION_TABLE is the
    // fallback for every stop that never met a planner. Only the BASE is
    // the model's to judge — the buffer is a scheduling margin (transition,
    // ordering, settling), a policy of ours rather than a fact about the
    // venue, so it keeps coming from the table for the resolved category.
    const table = getDuration(sel.category);
    const baseMinutes = sel.plannedMinutes ?? table.baseMinutes;
    const { bufferMinutes } = table;
    const total = baseMinutes + bufferMinutes;
    const stopStart = new Date(cursor);
    cursor = new Date(cursor.getTime() + total * 60_000);

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
    cursor = new Date(cursor.getTime() + (leg?.totalMinutes ?? 0) * 60_000);
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
