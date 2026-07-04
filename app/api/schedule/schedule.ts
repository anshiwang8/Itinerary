// Pure stop-time scheduling (step 6a). Travel legs are a placeholder —
// the Routes API step inserts real travel time later.
import { parseTargetTime } from "../places/search/hours";
import { getDuration } from "./durations";
import { TravelLeg } from "./travel";

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
  [/comedy|show|theatre|theater|concert/i, { hour: 20, minute: 0 }],
  [/club/i, { hour: 22, minute: 0 }],
  [/\bbars?\b|cocktail|pub|brewery|wine|drink/i, { hour: 20, minute: 0 }],
  [
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

// NOTE: date components are built with server-local Date math; the
// prototype assumes the server runs in America/Toronto (true for local
// dev). The offset in the ISO output is computed properly per-date.
function toTorontoISO(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  const zone =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Toronto",
      timeZoneName: "longOffset",
    })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const offset = zone === "GMT" ? "+00:00" : zone.replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/**
 * Resolve time_window to a concrete start Date. This is the single
 * source of truth for "when does the outing start" — the hours filter,
 * weather gate, and schedule all call it so they agree on one instant.
 * 1. Clock time present → parseTargetTime (day-of-week aware).
 * 2. Day-part keyword → DAY_PART_DEFAULTS (respecting "tomorrow").
 * 3. Neither → infer a day-part from the first category (anchor).
 * 4. Otherwise → next full hour from now.
 */
export function resolveStartTime(
  timeWindow: string,
  now: Date = new Date(),
  categories: string[] = []
): Date {
  const tw = (timeWindow ?? "").toLowerCase();

  // A start in the past is never a valid plan: "this afternoon" asked at
  // 6pm, or "6am" asked at noon, means the next occurrence.
  const rollForward = (d: Date): Date => {
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  };

  const target = parseTargetTime(tw, now);
  if (target) {
    const daysAhead = (target.day - now.getDay() + 7) % 7;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead);
    d.setHours(target.hour, target.minute, 0, 0);
    return rollForward(d);
  }

  for (const [keyword, t] of Object.entries(DAY_PART_DEFAULTS)) {
    if (tw.includes(keyword)) {
      const dayOffset = tw.includes("tomorrow") ? 1 : 0;
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
      d.setHours(t.hour, t.minute, 0, 0);
      return rollForward(d);
    }
  }

  // no clock time, no day-part → infer from the first stop's category
  const anchor = categories.find((c) => typeof c === "string" && c.trim());
  const inferred = inferCategoryStart(anchor);
  if (inferred) {
    const dayOffset = tw.includes("tomorrow") ? 1 : 0;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    d.setHours(inferred.hour, inferred.minute, 0, 0);
    return rollForward(d);
  }

  // unspecified → next full hour
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

export interface SelectionLike {
  category: string;
  id: string | null;
  name?: string;
  reason?: string;
  fallback?: boolean;
  rating?: number;
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
 */
export function buildSchedule(
  selections: SelectionLike[],
  timeWindow: string,
  now: Date = new Date(),
  travelLegs: TravelLeg[] = []
): { startISO: string; stops: ScheduledStop[] } {
  const start = resolveStartTime(
    timeWindow,
    now,
    selections.map((s) => s.category)
  );
  const cursor = new Date(start);

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
      start_time: toTorontoISO(stopStart),
      end_time: toTorontoISO(cursor),
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

  return { startISO: toTorontoISO(start), stops: timed };
}
