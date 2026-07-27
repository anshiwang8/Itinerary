import type { ParsedPrompt, Place, WeatherHour } from "../places/search/filter";
import type { LatLng } from "../schedule/travel";
import type { TravelLeg } from "../schedule/travel";
import type { ScheduledStop } from "../schedule/schedule";
import type { HomePoint } from "../schedule/home";
import { normalizeStopCountSlots } from "../../lib/planSlots";
import {
  REQUEST_LIMITS,
  badRequest,
  finiteNumber,
  isRecord,
  validIanaTimeZone,
  validIsoInstant,
  validLatitude,
  validLongitude,
} from "./http";

function boundedString(
  value: unknown,
  field: string,
  max: number = REQUEST_LIMITS.textFieldChars
): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    badRequest(`\`${field}\` must be a non-empty string no longer than ${max} characters.`);
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  field: string,
  max: number = REQUEST_LIMITS.textFieldChars
): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, field, max);
}

function stringList(
  value: unknown,
  field: string,
  maxItems = REQUEST_LIMITS.categories
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    badRequest(`\`${field}\` must be an array with at most ${maxItems} entries.`);
  }
  return value.map((item, index) => boundedString(item, `${field}[${index}]`));
}

export function parsePromptBody(value: unknown): string {
  if (!isRecord(value)) badRequest("Request body must be a JSON object.");
  return boundedString(value.prompt, "prompt", REQUEST_LIMITS.promptChars);
}

/** One answered clarifying question, echoed back for the second planner pass. */
export interface PlannerAnswerInput {
  question: string;
  answer: string;
}

export interface PlannerRequest {
  prompt: string;
  /** the plan's resolved IANA zone — the planner reasons about "tonight"
   *  against the PLAN's clock, so the client geocodes before it parses */
  timeZone?: string;
  /** the client's current instant. The planner is the first stage that needs
   *  to know what "now" is, and the app already resolves start times from the
   *  browser clock (page.tsx passes `new Date()` into every resolver) — so
   *  accepting it here matches the existing trust model rather than widening
   *  it, and keeps the e2e clock-freeze seam working. Defaults to the
   *  server clock when absent. */
  nowISO?: string;
  city?: string;
  answers?: PlannerAnswerInput[];
}

export function parsePlannerBody(value: unknown): PlannerRequest {
  if (!isRecord(value)) badRequest("Request body must be a JSON object.");
  const request: PlannerRequest = {
    prompt: boundedString(value.prompt, "prompt", REQUEST_LIMITS.promptChars),
  };
  const timeZone = parseOptionalTimeZone(value.timeZone);
  if (timeZone) request.timeZone = timeZone;
  const nowISO = parseOptionalInstant(value.nowISO, "nowISO");
  if (nowISO) request.nowISO = nowISO;
  const city = optionalString(value.city, "city");
  if (city) request.city = city;
  if (value.answers !== undefined) {
    if (!Array.isArray(value.answers) || value.answers.length > REQUEST_LIMITS.categories) {
      badRequest(`\`answers\` must be an array with at most ${REQUEST_LIMITS.categories} entries.`);
    }
    request.answers = value.answers.map((entry, index) => {
      if (!isRecord(entry)) badRequest(`\`answers[${index}]\` must be an object.`);
      return {
        question: boundedString(entry.question, `answers[${index}].question`),
        answer: boundedString(entry.answer, `answers[${index}].answer`, REQUEST_LIMITS.refinementChars),
      };
    });
  }
  return request;
}

export function parseRefinement(value: unknown): string {
  return boundedString(value, "refinement", REQUEST_LIMITS.refinementChars);
}

export function parseParsedPrompt(value: unknown): ParsedPrompt {
  if (!isRecord(value)) badRequest("`parsed` must be a valid parsed prompt object.");
  const stopCount = value.stop_count;
  if (
    stopCount !== null &&
    stopCount !== undefined &&
    (!finiteNumber(stopCount) ||
      !Number.isInteger(stopCount) ||
      stopCount < 1 ||
      stopCount > REQUEST_LIMITS.categories)
  ) {
    badRequest(`\`parsed.stop_count\` must be null or an integer from 1 to ${REQUEST_LIMITS.categories}.`);
  }
  const budget =
    value.budget === null || value.budget === undefined
      ? null
      : boundedString(value.budget, "parsed.budget");
  const parsed: ParsedPrompt = {
    time_window: boundedString(value.time_window, "parsed.time_window"),
    stop_count: typeof stopCount === "number" ? stopCount : null,
    aesthetic: boundedString(value.aesthetic, "parsed.aesthetic"),
    category_signals: stringList(value.category_signals, "parsed.category_signals"),
    group_context: boundedString(value.group_context, "parsed.group_context"),
    budget,
    constraints: stringList(value.constraints, "parsed.constraints"),
    location:
      typeof value.location === "string" && value.location.length <= REQUEST_LIMITS.textFieldChars
        ? value.location.trim()
        : badRequest("`parsed.location` must be a string."),
  };
  const city = optionalString(value.city, "parsed.city");
  if (city) parsed.city = city;
  if (value.home !== undefined) {
    if (
      !isRecord(value.home) ||
      !validLatitude(value.home.latitude) ||
      !validLongitude(value.home.longitude)
    ) {
      badRequest("`parsed.home` must contain valid latitude and longitude.");
    }
    parsed.home = {
      latitude: value.home.latitude,
      longitude: value.home.longitude,
    };
  }
  return normalizeStopCountSlots(parsed);
}

function parsePlace(value: unknown, field: string): Place {
  if (!isRecord(value)) badRequest(`\`${field}\` must be an object.`);
  const id = boundedString(value.id, `${field}.id`, 200);
  const place: Place = { ...(value as unknown as Place), id };
  if (
    place.location &&
    (!validLatitude(place.location.latitude) || !validLongitude(place.location.longitude))
  ) {
    badRequest(`\`${field}.location\` contains invalid coordinates.`);
  }
  if (place.rating !== undefined && (!finiteNumber(place.rating) || place.rating < 0 || place.rating > 5)) {
    badRequest(`\`${field}.rating\` must be between 0 and 5.`);
  }
  return place;
}

export function parsePools(value: unknown): Record<string, Place[]> {
  if (!isRecord(value)) badRequest("`pools` must be an object.");
  const entries = Object.entries(value);
  if (entries.length > REQUEST_LIMITS.categories) {
    badRequest(`\`pools\` may contain at most ${REQUEST_LIMITS.categories} categories.`);
  }
  let total = 0;
  const pools: Record<string, Place[]> = {};
  for (const [category, raw] of entries) {
    if (!category.trim() || category.length > REQUEST_LIMITS.textFieldChars || !Array.isArray(raw)) {
      badRequest("Each candidate pool must be an array under a valid category.");
    }
    if (raw.length > REQUEST_LIMITS.candidatesPerPool) {
      badRequest(`Each pool may contain at most ${REQUEST_LIMITS.candidatesPerPool} candidates.`);
    }
    total += raw.length;
    if (total > REQUEST_LIMITS.totalCandidates) {
      badRequest(`Candidate payload may contain at most ${REQUEST_LIMITS.totalCandidates} candidates.`);
    }
    pools[category] = raw.map((candidate, index) =>
      parsePlace(candidate, `pools.${category}[${index}]`)
    );
  }
  return pools;
}

export function parseSlots(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return stringList(value, "slots");
}

export function parseCategories(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return stringList(value, "categoriesOverride");
}

export function parseWeather(value: unknown): WeatherHour[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 48) badRequest("`weather` must contain at most 48 hours.");
  return value.map((entry, index) => {
    if (!isRecord(entry) || !validIsoInstant(entry.hourISO)) {
      badRequest(`\`weather[${index}]\` must contain a valid hourISO.`);
    }
    for (const key of ["tempC", "precipProbability"] as const) {
      if (entry[key] !== null && entry[key] !== undefined && !finiteNumber(entry[key])) {
        badRequest(`\`weather[${index}].${key}\` must be finite or null.`);
      }
    }
    return {
      hourISO: entry.hourISO,
      tempC: finiteNumber(entry.tempC) ? entry.tempC : null,
      precipProbability: finiteNumber(entry.precipProbability)
        ? entry.precipProbability
        : null,
      condition: typeof entry.condition === "string" ? entry.condition.slice(0, 200) : null,
    };
  });
}

export function parsePoints(value: unknown): LatLng[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > REQUEST_LIMITS.points) {
    badRequest(`\`points\` must contain between 1 and ${REQUEST_LIMITS.points} coordinates.`);
  }
  return value.map((point, index) => {
    if (!isRecord(point) || !validLatitude(point.latitude) || !validLongitude(point.longitude)) {
      badRequest(`\`points[${index}]\` must contain valid latitude and longitude.`);
    }
    return { latitude: point.latitude, longitude: point.longitude };
  });
}

export function parseDwellMinutes(value: unknown, points: number): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== points) {
    badRequest("`dwellMinutes` must have exactly one entry per point.");
  }
  return value.map((minutes, index) => {
    if (!finiteNumber(minutes) || !Number.isInteger(minutes) || minutes < 0 || minutes > 360) {
      badRequest(`\`dwellMinutes[${index}]\` must be an integer from 0 to 360.`);
    }
    return minutes;
  });
}

export function parseOptionalInstant(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!validIsoInstant(value)) badRequest(`\`${field}\` must be a valid ISO timestamp.`);
  return value;
}

export function parseOptionalTimeZone(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!validIanaTimeZone(value)) badRequest("`timeZone` must be a valid IANA timezone.");
  return value;
}

export function parseOptionalVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    !finiteNumber(value) ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    badRequest("`version` must be a positive safe integer.");
  }
  return value;
}

export function parseScheduledStops(value: unknown): ScheduledStop[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > REQUEST_LIMITS.categories
  ) {
    badRequest(
      `\`stops\` must contain between 1 and ${REQUEST_LIMITS.categories} stops.`
    );
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) badRequest(`\`stops[${index}]\` must be an object.`);
    const category = boundedString(entry.category, `stops[${index}].category`);
    const id =
      entry.id === null ? null : boundedString(entry.id, `stops[${index}].id`, 200);
    for (const field of ["start_time", "end_time"] as const) {
      if (entry[field] !== null && !validIsoInstant(entry[field])) {
        badRequest(`\`stops[${index}].${field}\` must be a valid ISO timestamp or null.`);
      }
    }
    if (entry.location !== undefined) {
      if (
        !isRecord(entry.location) ||
        !validLatitude(entry.location.latitude) ||
        !validLongitude(entry.location.longitude)
      ) {
        badRequest(`\`stops[${index}].location\` contains invalid coordinates.`);
      }
    }
    if (entry.durationMinutes !== null) {
      if (!isRecord(entry.durationMinutes)) {
        badRequest(`\`stops[${index}].durationMinutes\` must be an object or null.`);
      }
      for (const field of ["base", "buffer", "total"] as const) {
        const minutes = entry.durationMinutes[field];
        if (
          !finiteNumber(minutes) ||
          !Number.isInteger(minutes) ||
          minutes < 0 ||
          minutes > 360
        ) {
          badRequest(
            `\`stops[${index}].durationMinutes.${field}\` must be an integer from 0 to 360.`
          );
        }
      }
    }
    return { ...(entry as unknown as ScheduledStop), id, category };
  });
}

export function parseTravelLegs(value: unknown, field = "legs"): TravelLeg[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > REQUEST_LIMITS.points - 1) {
    badRequest(`\`${field}\` must contain at most ${REQUEST_LIMITS.points - 1} legs.`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) badRequest(`\`${field}[${index}]\` must be an object.`);
    if (
      !finiteNumber(entry.fromIndex) ||
      !Number.isInteger(entry.fromIndex) ||
      entry.fromIndex < -1 ||
      entry.fromIndex >= REQUEST_LIMITS.points
    ) {
      badRequest(`\`${field}[${index}].fromIndex\` is invalid.`);
    }
    if (!["transit", "walk", "unknown"].includes(String(entry.mode))) {
      badRequest(`\`${field}[${index}].mode\` is invalid.`);
    }
    for (const key of ["rawMinutes", "marginMinutes", "totalMinutes"] as const) {
      if (
        !finiteNumber(entry[key]) ||
        !Number.isInteger(entry[key]) ||
        entry[key] < 0 ||
        entry[key] > 1_440
      ) {
        badRequest(`\`${field}[${index}].${key}\` must be a non-negative integer.`);
      }
    }
    if (
      entry.distanceMeters !== null &&
      (!finiteNumber(entry.distanceMeters) || entry.distanceMeters < 0)
    ) {
      badRequest(`\`${field}[${index}].distanceMeters\` must be non-negative or null.`);
    }
    return entry as unknown as TravelLeg;
  });
}

export function parseHomePoint(value: unknown): HomePoint | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    value.label.trim() === "" ||
    value.label.length > 500 ||
    !isRecord(value.location) ||
    !validLatitude(value.location.latitude) ||
    !validLongitude(value.location.longitude)
  ) {
    badRequest("`home` must contain a label and valid coordinates.");
  }
  return {
    label: value.label.trim(),
    location: {
      latitude: value.location.latitude,
      longitude: value.location.longitude,
    },
  };
}
