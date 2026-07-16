// Objective (non-LLM) filter for Places candidate pools. Applies hard
// rules per venue, in order, and records every drop so filter
// aggressiveness stays visible. Weather gating is a later step.
import { CurrentOpeningHours, isOpenAt, TargetTime } from "./hours";
import { resolveStartTime } from "../../schedule/schedule";
import { DEFAULT_ZONE, wallClockParts } from "../../../lib/zoneTime";

export interface Place {
  id: string;
  displayName?: { text: string };
  location?: { latitude: number; longitude: number };
  rating?: number;
  priceLevel?: string;
  currentOpeningHours?: CurrentOpeningHours;
  businessStatus?: string;
  /** one-line venue blurb — shown on the stop card, and constraint
   * evidence for the selector */
  editorialSummary?: { text: string };
}

// Shape returned by /api/parse.
export interface ParsedPrompt {
  time_window: string;
  stop_count: number | null;
  aesthetic: string;
  category_signals: string[];
  group_context: string;
  budget: string | null;
  constraints: string[];
  /** neighbourhood/area WITHIN the city (from the prompt), e.g. "west end" */
  location: string;
  /** the user-supplied city (injected by the app after parse, NOT inferred
   * by the LLM); rides on parsed so swap/reroute re-searches inherit it.
   * Absent on pre-multi-city itineraries → search falls back to Toronto. */
  city?: string;
  /** the plan's geocoded starting point (injected by the app after geocode,
   * NOT inferred by the LLM); the select step computes each candidate's
   * distance from it so picks aren't distance-blind. Rides on parsed so
   * swap/reroute re-searches inherit the anchor. Absent on older plans. */
  home?: { latitude: number; longitude: number };
}

export type DropRule =
  | "businessStatus"
  | "hours"
  | "rating"
  | "price"
  | "dedup";

export interface DropEntry {
  category: string;
  name: string;
  id: string;
  rule: DropRule;
  detail: string;
}

export const RATING_FLOOR = 3.5;

// ── Weather gate ──
export interface WeatherHour {
  hourISO: string;
  tempC: number | null;
  precipProbability: number | null;
  condition: string | null;
}

export interface WeatherBlock {
  category: string;
  weatherBlocked: true;
  reason: string;
}

// strictly greater / strictly less block; the boundary values pass
export const PRECIP_BLOCK_THRESHOLD = 50;
export const COLD_BLOCK_THRESHOLD_C = -5;

const OUTDOOR_PATTERN =
  /park|walk|stroll|patio|garden|beach|trail|market|picnic|hike|outdoor/i;

/** Keyword matcher for weather-sensitive categories. */
export function isOutdoorCategory(raw: string): boolean {
  return OUTDOOR_PATTERN.test(raw ?? "");
}

// weather-block reason hour, in the venue's local zone ("rain at 8pm")
function hourLabel(d: Date, timeZone: string = DEFAULT_ZONE): string {
  const h = wallClockParts(d, timeZone).hour;
  return `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
}

/** Forecast hour covering the target instant, if within the horizon.
 *  Zone-safe as-is: compares ABSOLUTE epoch instants (getTime), never
 *  wall-clock components — the forecast bucket for an instant is the same
 *  regardless of which zone names that instant. */
function forecastAt(
  weather: WeatherHour[],
  target: Date
): WeatherHour | null {
  const t = target.getTime();
  return (
    weather.find((h) => {
      const start = new Date(h.hourISO).getTime();
      return !isNaN(start) && start <= t && t < start + 3_600_000;
    }) ?? null
  );
}

const DEAD_STATUSES = new Set(["CLOSED_PERMANENTLY", "CLOSED_TEMPORARILY"]);
const EXPENSIVE_LEVELS = new Set([
  "PRICE_LEVEL_EXPENSIVE",
  "PRICE_LEVEL_VERY_EXPENSIVE",
]);

// Budget language that signals "keep it cheap". Only these trigger the
// price rule; other budget phrasings pass through untouched for now.
function isCheapBudget(budget: string | null): boolean {
  if (!budget) return false;
  return /cheap|budget|broke|inexpensive|affordable|student|under\s*\$?\d+|^\$$/i.test(
    budget
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function fmtTarget(t: TargetTime): string {
  return `${DAY_NAMES[t.day]} ${String(t.hour).padStart(2, "0")}:${String(
    t.minute
  ).padStart(2, "0")}`;
}

export function filterPools(
  pools: Record<string, Place[]>,
  parsed: ParsedPrompt,
  weather: WeatherHour[] | null = null,
  now: Date = new Date(),
  // reroute engine anchors the replan at floor_time instead of the
  // original time_window resolution
  targetOverride?: Date,
  // the plan's zone — the hours target (day/hour/minute) is the VENUE's
  // local wall clock, not the server's (default Toronto)
  timeZone: string = DEFAULT_ZONE
): {
  pools: Record<string, Place[]>;
  dropLog: DropEntry[];
  weatherBlocked: WeatherBlock[];
} {
  const dropLog: DropEntry[] = [];
  const weatherBlocked: WeatherBlock[] = [];
  const cheap = isCheapBudget(parsed.budget);
  // Ids that already survived in an earlier category (original order).
  const seen = new Set<string>();
  const out: Record<string, Place[]> = {};

  // THE resolved start instant — identical to what buildSchedule will
  // book (same resolver, same category anchor). Hours filter and
  // weather gate both check this instant, so the three pipeline stages
  // can never disagree on the target time again.
  const startInstant =
    targetOverride ??
    resolveStartTime(parsed.time_window ?? "", now, Object.keys(pools), timeZone);
  // day-of-week/hour/minute in the VENUE's zone — a city far enough from
  // Toronto's offset can be a different weekday at the same instant, which
  // would silently look up the wrong day's opening hours. NOTE: TargetTime.day
  // is the day-of-WEEK (0=Sun), so use `weekday`, not the day-of-month.
  const { weekday, hour, minute } = wallClockParts(startInstant, timeZone);
  const target: TargetTime = { day: weekday, hour, minute };
  // No usable weather data → weather rule skipped entirely (same
  // keep-on-missing policy as hours/price).
  const forecast =
    weather && weather.length > 0 ? forecastAt(weather, startInstant) : null;

  for (const [category, places] of Object.entries(pools)) {
    // category-level weather block: outdoor + bad forecast at target
    if (isOutdoorCategory(category)) {
      if (!forecast) {
        // observability only — logic unchanged (missing data never blocks)
        console.log(
          `[weather-gate] category="${category}" target=${startInstant.toISOString()} forecast=NONE (no data or outside horizon) verdict=SKIPPED`
        );
      } else {
        let reason: string | null = null;
        if (
          forecast.precipProbability !== null &&
          forecast.precipProbability > PRECIP_BLOCK_THRESHOLD
        ) {
          reason = `rain likely at ${hourLabel(startInstant, timeZone)}`;
        } else if (
          forecast.tempC !== null &&
          forecast.tempC < COLD_BLOCK_THRESHOLD_C
        ) {
          reason = `too cold at ${hourLabel(startInstant, timeZone)} (${forecast.tempC}°C)`;
        }
        console.log(
          `[weather-gate] category="${category}" target=${startInstant.toISOString()} precip=${forecast.precipProbability}% (block >${PRECIP_BLOCK_THRESHOLD}%) tempC=${forecast.tempC} (block <${COLD_BLOCK_THRESHOLD_C}) verdict=${reason ? `BLOCK — ${reason}` : "ALLOW"}`
        );
        if (reason) {
          out[category] = [];
          weatherBlocked.push({ category, weatherBlocked: true, reason });
          continue;
        }
      }
    }

    const survivors: Place[] = [];
    for (const place of places) {
      const drop = (rule: DropRule, detail: string) =>
        dropLog.push({
          category,
          name: place.displayName?.text ?? "(unnamed)",
          id: place.id,
          rule,
          detail,
        });

      // a. dead venues
      if (place.businessStatus && DEAD_STATUSES.has(place.businessStatus)) {
        drop("businessStatus", place.businessStatus);
        continue;
      }

      // b. hours — checked against the resolved start instant (always
      // defined now); false drops, null (no usable data) always keeps
      {
        const verdict = isOpenAt(place.currentOpeningHours, target);
        if (verdict === false) {
          drop("hours", `closed at target ${fmtTarget(target)}`);
          continue;
        }
      }

      // c. rating floor — missing rating keeps
      if (typeof place.rating === "number" && place.rating < RATING_FLOOR) {
        drop("rating", `rating ${place.rating} < ${RATING_FLOOR}`);
        continue;
      }

      // d. price — only when budget stated AND priceLevel present
      if (
        cheap &&
        place.priceLevel &&
        EXPENSIVE_LEVELS.has(place.priceLevel)
      ) {
        drop("price", `${place.priceLevel} vs budget "${parsed.budget}"`);
        continue;
      }

      // e. cross-category dedup — first surviving occurrence wins
      if (seen.has(place.id)) {
        drop("dedup", "already surviving in an earlier category");
        continue;
      }

      seen.add(place.id);
      survivors.push(place);
    }
    out[category] = survivors;
  }

  return { pools: out, dropLog, weatherBlocked };
}
