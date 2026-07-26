import type { Itinerary } from "../api/itinerary/store";
import type { Selection } from "../api/select/selectVenues";
import type { TravelLeg, TransitSummary } from "../api/schedule/travel";
import type { CurrentOpeningHours } from "../api/places/search/hours";
import type { DropEntry, ParsedPrompt, Place } from "../api/places/search/filter";
import { normalizeZone } from "./zoneTime";

export interface ClientWeatherHour {
  hourISO: string;
  tempC: number | null;
  precipProbability: number | null;
  condition: string | null;
}

export interface ClientWeatherBlock {
  category: string;
  weatherBlocked: true;
  reason: string;
}

export interface PlacesPayload {
  pools: Record<string, Place[]>;
  drops: DropEntry[];
  weatherBlocks: ClientWeatherBlock[];
}

export type ReroutePayload =
  | { rerouted: false; reason: string }
  | {
      rerouted: true;
      floor_time: string;
      anchor_time: string;
      changed: Array<{
        stopIndex: number;
        before: { start: string | null };
      }>;
    };

export type SwapPayload =
  | { swapped: false; reason: string }
  | {
      swapped: true;
      reason: string;
      stopIndex: number;
      path: "refilter" | "research" | "time" | "duration";
      before: { category: string };
      downstreamShifted: number[];
    };

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as JsonRecord;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return (
    finiteNumber(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function validLegIndex(value: unknown): value is number {
  return (
    finiteNumber(value) &&
    Number.isSafeInteger(value) &&
    value >= -1 &&
    value <= 1_000
  );
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function validInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function nullableInstant(value: unknown): value is string | null {
  return value === null || validInstant(value);
}

function isLatLng(value: unknown): value is {
  latitude: number;
  longitude: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const location = value as JsonRecord;
  return (
    finiteNumber(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    finiteNumber(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

function isHoursPoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const point = value as JsonRecord;
  return (
    nonNegativeInteger(point.day, 6) &&
    nonNegativeInteger(point.hour, 23) &&
    nonNegativeInteger(point.minute, 59)
  );
}

function isCurrentOpeningHours(value: unknown): value is CurrentOpeningHours {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const hours = value as JsonRecord;
  if (!optionalBoolean(hours.openNow)) return false;
  if (hours.periods === undefined) return true;
  return (
    Array.isArray(hours.periods) &&
    hours.periods.every((period) => {
      if (
        typeof period !== "object" ||
        period === null ||
        Array.isArray(period)
      ) {
        return false;
      }
      const entry = period as JsonRecord;
      return (
        (entry.open === undefined || isHoursPoint(entry.open)) &&
        (entry.close === undefined || isHoursPoint(entry.close))
      );
    })
  );
}

function isTransitSummary(value: unknown): value is TransitSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const transit = value as JsonRecord;
  return (
    typeof transit.lineName === "string" &&
    nullableString(transit.shortName) &&
    nullableString(transit.color) &&
    nullableString(transit.textColor) &&
    nullableString(transit.vehicle) &&
    typeof transit.headsign === "string" &&
    (transit.stopCount === null ||
      nonNegativeInteger(transit.stopCount, 10_000)) &&
    typeof transit.departStop === "string" &&
    typeof transit.arriveStop === "string"
  );
}

function isPlace(value: unknown): value is Place {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const place = value as JsonRecord;
  return typeof place.id === "string" && place.id.length > 0;
}

function isDropEntry(value: unknown): value is DropEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const drop = value as JsonRecord;
  return (
    typeof drop.category === "string" &&
    typeof drop.name === "string" &&
    typeof drop.id === "string" &&
    typeof drop.rule === "string" &&
    typeof drop.detail === "string"
  );
}

function isWeatherBlock(value: unknown): value is ClientWeatherBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const block = value as JsonRecord;
  return (
    typeof block.category === "string" &&
    block.weatherBlocked === true &&
    typeof block.reason === "string"
  );
}

function isSelection(value: unknown): value is Selection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const selection = value as JsonRecord;
  return (
    typeof selection.category === "string" &&
    (selection.id === null || typeof selection.id === "string") &&
    typeof selection.reason === "string" &&
    (selection.slot === undefined ||
      (typeof selection.slot === "number" && Number.isInteger(selection.slot)))
  );
}

function isTravelLeg(value: unknown): value is TravelLeg {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const leg = value as JsonRecord;
  return (
    validLegIndex(leg.fromIndex) &&
    (leg.mode === "walk" ||
      leg.mode === "transit" ||
      leg.mode === "unknown") &&
    nonNegativeInteger(leg.rawMinutes, 1_440) &&
    nonNegativeInteger(leg.marginMinutes, 1_440) &&
    nonNegativeInteger(leg.totalMinutes, 1_440) &&
    (leg.distanceMeters === null ||
      (finiteNumber(leg.distanceMeters) && leg.distanceMeters >= 0)) &&
    nullableString(leg.encodedPolyline) &&
    (leg.transit === undefined || isTransitSummary(leg.transit)) &&
    (leg.transitSegments === undefined ||
      (Array.isArray(leg.transitSegments) &&
        leg.transitSegments.every(isTransitSummary)))
  );
}

function isDurationMinutes(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const duration = value as JsonRecord;
  return (
    nonNegativeInteger(duration.base, 360) &&
    nonNegativeInteger(duration.buffer, 360) &&
    nonNegativeInteger(duration.total, 360)
  );
}

function isItineraryStop(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const stop = value as JsonRecord;
  return (
    typeof stop.category === "string" &&
    stop.category.trim().length > 0 &&
    (stop.id === null ||
      (typeof stop.id === "string" && stop.id.trim().length > 0)) &&
    optionalString(stop.name) &&
    optionalString(stop.reason) &&
    optionalBoolean(stop.fallback) &&
    (stop.slot === undefined ||
      nonNegativeInteger(stop.slot, 10_000)) &&
    (stop.rating === undefined || finiteNumber(stop.rating)) &&
    optionalString(stop.priceLevel) &&
    optionalString(stop.description) &&
    (stop.currentOpeningHours === undefined ||
      isCurrentOpeningHours(stop.currentOpeningHours)) &&
    (stop.location === undefined || isLatLng(stop.location)) &&
    nullableInstant(stop.start_time) &&
    nullableInstant(stop.end_time) &&
    isDurationMinutes(stop.durationMinutes) &&
    (stop.travelMinutesToNext === undefined ||
      nonNegativeInteger(stop.travelMinutesToNext, 1_440)) &&
    (stop.travelToNext === undefined || isTravelLeg(stop.travelToNext)) &&
    (stop.status === "upcoming" ||
      stop.status === "active" ||
      stop.status === "completed" ||
      stop.status === "skipped") &&
    typeof stop.locked === "boolean"
  );
}

function isHomePoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const home = value as JsonRecord;
  return (
    typeof home.label === "string" &&
    home.label.trim().length > 0 &&
    isLatLng(home.location)
  );
}

function isIanaTimeZone(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    normalizeZone(value) === value
  );
}

export function parseParsedPayload(value: unknown): ParsedPrompt {
  const parsed = record(value);
  if (
    typeof parsed.time_window !== "string" ||
    (parsed.stop_count !== null &&
      (typeof parsed.stop_count !== "number" || !Number.isInteger(parsed.stop_count))) ||
    typeof parsed.aesthetic !== "string" ||
    !strings(parsed.category_signals) ||
    typeof parsed.group_context !== "string" ||
    (parsed.budget !== null && typeof parsed.budget !== "string") ||
    !strings(parsed.constraints) ||
    typeof parsed.location !== "string" ||
    (parsed.city !== undefined && typeof parsed.city !== "string") ||
    (parsed.home !== undefined && !isLatLng(parsed.home))
  ) {
    throw new Error("invalid parsed prompt");
  }
  return parsed as unknown as ParsedPrompt;
}

export function parseGeocodePayload(value: unknown): {
  label?: string;
  location: { latitude: number; longitude: number };
  timeZone?: string;
} {
  const data = record(value);
  const location = record(data.location);
  if (
    typeof location.latitude !== "number" ||
    !Number.isFinite(location.latitude) ||
    typeof location.longitude !== "number" ||
    !Number.isFinite(location.longitude) ||
    (data.label !== undefined && typeof data.label !== "string") ||
    (data.timeZone !== undefined && typeof data.timeZone !== "string")
  ) {
    throw new Error("invalid geocode");
  }
  return data as {
    label?: string;
    location: { latitude: number; longitude: number };
    timeZone?: string;
  };
}

export function parseWeatherPayload(value: unknown): ClientWeatherHour[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const hour = entry as JsonRecord;
      return (
        typeof hour.hourISO === "string" &&
        nullableNumber(hour.tempC) &&
        nullableNumber(hour.precipProbability) &&
        nullableString(hour.condition)
      );
    })
  ) {
    throw new Error("invalid weather");
  }
  return value as ClientWeatherHour[];
}

export function parsePlacesPayload(value: unknown): PlacesPayload {
  const data = record(value);
  const pools: Record<string, Place[]> = {};
  for (const [category, candidates] of Object.entries(data)) {
    if (category === "_dropLog" || category === "_weatherBlocked") continue;
    if (!Array.isArray(candidates) || !candidates.every(isPlace)) {
      throw new Error("invalid place pool");
    }
    pools[category] = candidates;
  }
  const drops = data._dropLog ?? [];
  const weatherBlocks = data._weatherBlocked ?? [];
  if (
    !Array.isArray(drops) ||
    !drops.every(isDropEntry) ||
    !Array.isArray(weatherBlocks) ||
    !weatherBlocks.every(isWeatherBlock)
  ) {
    throw new Error("invalid place metadata");
  }
  return { pools, drops, weatherBlocks };
}

export function parseSelectionsPayload(value: unknown): { selections: Selection[] } {
  const data = record(value);
  if (!Array.isArray(data.selections) || !data.selections.every(isSelection)) {
    throw new Error("invalid selections");
  }
  return { selections: data.selections };
}

export function parseTravelPayload(value: unknown): { legs: TravelLeg[] } {
  const data = record(value);
  if (!Array.isArray(data.legs) || !data.legs.every(isTravelLeg)) {
    throw new Error("invalid travel legs");
  }
  return { legs: data.legs };
}

export function parseCreatePayload(value: unknown): { id: string } {
  const data = record(value);
  if (typeof data.id !== "string" || data.id.length === 0) {
    throw new Error("invalid itinerary id");
  }
  return { id: data.id };
}

export function parseItineraryPayload(value: unknown): Itinerary {
  const data = record(value);
  if (
    typeof data.id !== "string" ||
    data.id.trim().length === 0 ||
    !nonNegativeInteger(data.version) ||
    data.version < 1 ||
    !validInstant(data.createdAt) ||
    !Array.isArray(data.stops) ||
    !data.stops.every(isItineraryStop) ||
    !Array.isArray(data.legs) ||
    !data.legs.every(isTravelLeg) ||
    (data.status !== "planning" &&
      data.status !== "active" &&
      data.status !== "completed") ||
    (data.homeLeg !== undefined && !isTravelLeg(data.homeLeg)) ||
    (data.home !== undefined && !isHomePoint(data.home)) ||
    (data.timeZone !== undefined && !isIanaTimeZone(data.timeZone))
  ) {
    throw new Error("invalid itinerary");
  }
  if (data.parsed !== undefined) parseParsedPayload(data.parsed);
  return data as unknown as Itinerary;
}

export function parseReroutePayload(value: unknown): ReroutePayload {
  const data = record(value);
  if (data.rerouted === false && typeof data.reason === "string") {
    return { rerouted: false, reason: data.reason };
  }
  if (
    data.rerouted !== true ||
    typeof data.floor_time !== "string" ||
    typeof data.anchor_time !== "string" ||
    !Array.isArray(data.changed) ||
    !data.changed.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const changed = entry as JsonRecord;
      if (typeof changed.stopIndex !== "number" || !Number.isInteger(changed.stopIndex)) {
        return false;
      }
      const before = changed.before;
      return (
        typeof before === "object" &&
        before !== null &&
        !Array.isArray(before) &&
        nullableString((before as JsonRecord).start)
      );
    })
  ) {
    throw new Error("invalid reroute");
  }
  return data as unknown as ReroutePayload;
}

export function parseSwapPayload(value: unknown): SwapPayload {
  const data = record(value);
  if (data.swapped === false && typeof data.reason === "string") {
    return { swapped: false, reason: data.reason };
  }
  if (
    data.swapped !== true ||
    typeof data.reason !== "string" ||
    typeof data.stopIndex !== "number" ||
    !Number.isInteger(data.stopIndex) ||
    !["refilter", "research", "time", "duration"].includes(String(data.path)) ||
    !Array.isArray(data.downstreamShifted) ||
    !data.downstreamShifted.every(
      (index) => typeof index === "number" && Number.isInteger(index)
    )
  ) {
    throw new Error("invalid swap");
  }
  const before = record(data.before);
  if (typeof before.category !== "string") throw new Error("invalid swap before");
  return data as unknown as SwapPayload;
}
