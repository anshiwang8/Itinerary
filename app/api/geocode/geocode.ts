import { zoneFromLatLng } from "./zoneLookup";
import {
  ApiError,
  REQUEST_LIMITS,
  isRecord,
  validLatitude,
  validLongitude,
} from "../_shared/http";
import { ProviderError, requireProviderRecord } from "../_shared/provider";
import { haversineMeters } from "../schedule/travel";

const GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const MAX_PROVIDER_RESULTS = 50;
const MAX_CANDIDATES = 5;

/**
 * How far a starting address may sit from the selected city's centre and
 * still be a plausible place to start a day IN that city. People live in
 * suburbs: Mississauga is ~25 km from downtown Toronto, Oakville ~35 km,
 * Hamilton ~60 km, and every one of them is a real commute into the city.
 * A start beyond this is not a commute — it is a typo'd city or the wrong
 * Springfield, and refusing it is the honest answer.
 *
 * This is also the app's ONLY distance cap on a starting point. Without
 * it a 200 km typo geocodes fine and turns into a silent multi-hour
 * home → first stop leg, because `getSingleLeg` will happily estimate any
 * distance. The bad address never resolves, so that leg is never built.
 */
export const MAX_START_DISTANCE_FROM_CITY_METERS = 75_000;

/**
 * Inside this radius a region (province/state) mismatch is NOT a refusal.
 * The region check is a SECONDARY signal to the distance test, and every
 * near-but-cross-region address is a real metro suburb rather than a
 * mistake — Gatineau QC for an Ottawa ON plan is 2 km away, Jersey City NJ
 * for New York is 10 km, Kansas City KS for Kansas City MO is 5 km. Past
 * this radius a different region is genuine evidence of a wrong city.
 */
export const SAME_METRO_METERS = 25_000;

/** Verdict on a geocoded start against the selected city. PURE, and the
 *  whole "is this a plausible start" rule: one distance comparison plus a
 *  secondary region signal. Distance is code's fact to own, never a
 *  judgment call, so it is decided here and not by name equality. */
export type StartProximity = "in-range" | "wrong-region" | "too-far";

export function judgeStartProximity(
  start: GeocodePoint,
  city: GeocodePoint,
  regionMatches: boolean,
  maxMeters: number = MAX_START_DISTANCE_FROM_CITY_METERS
): StartProximity {
  const meters = haversineMeters(start, city);
  if (meters > maxMeters) return "too-far";
  if (!regionMatches && meters > SAME_METRO_METERS) return "wrong-region";
  return "in-range";
}

const CITY_RESULT_TYPES = new Set([
  "locality",
  "postal_town",
  "administrative_area_level_3",
]);
const ADDRESS_RESULT_TYPES = new Set([
  "street_address",
  "subpremise",
  "premise",
  "establishment",
  "point_of_interest",
  "transit_station",
  "airport",
]);

/**
 * "reverse" is the coordinate -> label direction, added for the starting
 * location field's "Use current location" row. It is a THIRD kind rather
 * than a flag on "address" because it is judged by different rules: a GPS
 * fix legitimately lands on a route, a neighbourhood or a plus code, none
 * of which the address branch's completeness test would accept.
 */
export type GeocodeQueryType = "city" | "address" | "reverse";

export interface GeocodePoint {
  latitude: number;
  longitude: number;
}

export interface GeocodeBounds {
  southwest: GeocodePoint;
  northeast: GeocodePoint;
}

export interface GeocodeCandidate {
  label: string;
  formattedAddress: string;
  location: GeocodePoint;
  timeZone: string;
  locality: string;
  administrativeArea?: string;
  country: string;
  countryCode: string;
  resultTypes: string[];
  bounds?: GeocodeBounds;
  placeId?: string;
}

export interface CityContext {
  locality: string;
  administrativeArea?: string;
  country: string;
  countryCode: string;
  location: GeocodePoint;
  bounds?: GeocodeBounds;
}

export interface GeocodeRequest {
  /** The typed text. Empty on a reverse request, which has no text. */
  query: string;
  kind: GeocodeQueryType;
  cityContext?: CityContext;
  /** REVERSE ONLY: the device's own coordinate, which is the fact being
   *  named. Never set for a city or address lookup. */
  location?: GeocodePoint;
}

export interface ResolvedGeocode extends GeocodeCandidate {
  outcome: "resolved";
  queryType: GeocodeQueryType;
}

export interface AmbiguousGeocode {
  outcome: "ambiguous";
  queryType: GeocodeQueryType;
  code: "geocode_ambiguous";
  message: string;
  candidates: GeocodeCandidate[];
}

export type GeocodeOutcome = ResolvedGeocode | AmbiguousGeocode;

interface ParsedComponent {
  longName: string;
  shortName: string;
  types: string[];
}

interface ParsedResult {
  candidate: GeocodeCandidate;
  components: ParsedComponent[];
  partial: boolean;
}

function invalidProvider(): never {
  throw new ProviderError("geocoding", 502, "geocoding_invalid_response");
}

function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= REQUEST_LIMITS.textFieldChars
  );
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en");
}

function parseStringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 20 ||
    !value.every(validText)
  ) {
    invalidProvider();
  }
  return value;
}

function parseProviderPoint(value: unknown): GeocodePoint {
  if (
    !isRecord(value) ||
    !validLatitude(value.lat) ||
    !validLongitude(value.lng)
  ) {
    invalidProvider();
  }
  return { latitude: value.lat, longitude: value.lng };
}

function parseInputPoint(value: unknown, field: string): GeocodePoint {
  if (
    !isRecord(value) ||
    !validLatitude(value.latitude) ||
    !validLongitude(value.longitude)
  ) {
    throw new ApiError(
      400,
      "invalid_geocode_context",
      `\`${field}\` must contain valid latitude and longitude values.`
    );
  }
  return { latitude: value.latitude, longitude: value.longitude };
}

function validBounds(bounds: GeocodeBounds): boolean {
  return bounds.southwest.latitude <= bounds.northeast.latitude;
}

function parseProviderBounds(value: unknown): GeocodeBounds | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) invalidProvider();
  const bounds = {
    southwest: parseProviderPoint(value.southwest),
    northeast: parseProviderPoint(value.northeast),
  };
  if (!validBounds(bounds)) invalidProvider();
  return bounds;
}

function parseInputBounds(value: unknown): GeocodeBounds | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ApiError(
      400,
      "invalid_geocode_context",
      "`cityContext.bounds` must contain southwest and northeast coordinates."
    );
  }
  const bounds = {
    southwest: parseInputPoint(value.southwest, "cityContext.bounds.southwest"),
    northeast: parseInputPoint(value.northeast, "cityContext.bounds.northeast"),
  };
  if (!validBounds(bounds)) {
    throw new ApiError(
      400,
      "invalid_geocode_context",
      "`cityContext.bounds` has an invalid latitude range."
    );
  }
  return bounds;
}

function parseCityContext(value: unknown): CityContext {
  if (!isRecord(value)) {
    throw new ApiError(
      400,
      "city_context_required",
      "An address must be resolved within a selected city."
    );
  }
  if (
    !validText(value.locality) ||
    !validText(value.country) ||
    !validText(value.countryCode) ||
    !/^[A-Za-z]{2}$/.test(value.countryCode) ||
    (value.administrativeArea !== undefined && !validText(value.administrativeArea))
  ) {
    throw new ApiError(
      400,
      "invalid_geocode_context",
      "The selected city is missing valid locality, region, or country details."
    );
  }
  return {
    locality: value.locality.trim(),
    administrativeArea:
      typeof value.administrativeArea === "string"
        ? value.administrativeArea.trim()
        : undefined,
    country: value.country.trim(),
    countryCode: value.countryCode.toUpperCase(),
    location: parseInputPoint(value.location, "cityContext.location"),
    bounds: parseInputBounds(value.bounds),
  };
}

export function parseGeocodeRequest(value: unknown): GeocodeRequest {
  if (
    !isRecord(value) ||
    (value.kind !== "city" && value.kind !== "address" && value.kind !== "reverse")
  ) {
    throw new ApiError(
      400,
      "invalid_query",
      '`kind` must be "city", "address", or "reverse".'
    );
  }

  // A reverse request carries a COORDINATE and no text. The city context is
  // OPTIONAL here, unlike the address branch: the dropdown asks what a point
  // is called before any city has been resolved, and the pipeline asks again
  // with the resolved city when it is time to check the point is a plausible
  // start. Same function, two questions.
  if (value.kind === "reverse") {
    const request: GeocodeRequest = {
      query: "",
      kind: "reverse",
      location: parseInputPoint(value.location, "location"),
    };
    if (value.cityContext !== undefined) {
      request.cityContext = parseCityContext(value.cityContext);
    }
    return request;
  }

  if (
    typeof value.query !== "string" ||
    value.query.trim().length === 0 ||
    value.query.length > REQUEST_LIMITS.promptChars
  ) {
    throw new ApiError(
      400,
      "invalid_query",
      `\`query\` must be a non-empty string no longer than ${REQUEST_LIMITS.promptChars} characters.`
    );
  }
  const request: GeocodeRequest = {
    query: value.query.trim(),
    kind: value.kind,
  };
  if (request.kind === "address") {
    request.cityContext = parseCityContext(value.cityContext);
  }
  return request;
}

function fallbackBounds(location: GeocodePoint): GeocodeBounds {
  // Roughly a 25 km city-centre bias. It is a preference, not a boundary;
  // country/locality checks below still decide whether a result is usable.
  const latitudeDelta = 0.225;
  const longitudeDelta = Math.min(
    1,
    0.225 / Math.max(0.2, Math.cos((location.latitude * Math.PI) / 180))
  );
  return {
    southwest: {
      latitude: Math.max(-90, location.latitude - latitudeDelta),
      longitude: Math.max(-180, location.longitude - longitudeDelta),
    },
    northeast: {
      latitude: Math.min(90, location.latitude + latitudeDelta),
      longitude: Math.min(180, location.longitude + longitudeDelta),
    },
  };
}

function boundsParameter(bounds: GeocodeBounds): string {
  return [
    `${bounds.southwest.latitude},${bounds.southwest.longitude}`,
    `${bounds.northeast.latitude},${bounds.northeast.longitude}`,
  ].join("|");
}

export function buildGeocodeUrl(request: GeocodeRequest, apiKey: string): URL {
  const url = new URL(GEOCODING_URL);

  // REVERSE: `latlng` and nothing else. No bounds bias, no `components`
  // country filter, no region. Every one of those exists to disambiguate
  // TEXT, and there is no text here: a coordinate names exactly one point on
  // earth. Adding a country filter would be worse than useless, because it
  // would suppress results for a fix that is genuinely outside the selected
  // city's country instead of letting the check below report that plainly.
  if (request.kind === "reverse" && request.location) {
    url.searchParams.set(
      "latlng",
      `${request.location.latitude},${request.location.longitude}`
    );
    url.searchParams.set("key", apiKey);
    return url;
  }

  let address = request.query;
  if (request.kind === "address" && request.cityContext) {
    const context = request.cityContext;
    // The city's LOCALITY is deliberately NOT appended. A start outside the
    // city is legitimate (people commute in), and "12 Elm St, Mississauga"
    // + ", Toronto" is a self-contradictory query: the geocoder either
    // relocates it into Toronto or flags partial_match — so the address the
    // validator below is meant to judge never even arrives. Region and
    // country still disambiguate, and the city viewport still biases
    // ranking, which is what those two are for.
    const suffix = [context.administrativeArea, context.country].filter(
      (part): part is string => Boolean(part)
    );
    address = [address, ...suffix].join(", ");
    url.searchParams.set(
      "bounds",
      boundsParameter(context.bounds ?? fallbackBounds(context.location))
    );
    url.searchParams.set("components", `country:${context.countryCode}`);
    url.searchParams.set("region", context.countryCode.toLowerCase());
  }
  url.searchParams.set("address", address);
  url.searchParams.set("key", apiKey);
  return url;
}

function parseComponents(value: unknown): ParsedComponent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) {
    invalidProvider();
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      !validText(entry.long_name) ||
      !validText(entry.short_name)
    ) {
      invalidProvider();
    }
    return {
      longName: entry.long_name,
      shortName: entry.short_name,
      types: parseStringArray(entry.types),
    };
  });
}

function componentWithType(
  components: ParsedComponent[],
  types: string[]
): ParsedComponent | undefined {
  return components.find((component) =>
    types.some((type) => component.types.includes(type))
  );
}

function parseResult(value: unknown): ParsedResult {
  if (!isRecord(value) || !validText(value.formatted_address)) invalidProvider();
  if (
    value.partial_match !== undefined &&
    typeof value.partial_match !== "boolean"
  ) {
    invalidProvider();
  }
  const types = parseStringArray(value.types);
  const components = parseComponents(value.address_components);
  if (!isRecord(value.geometry)) invalidProvider();
  const location = parseProviderPoint(value.geometry.location);
  if (
    value.geometry.location_type !== undefined &&
    !validText(value.geometry.location_type)
  ) {
    invalidProvider();
  }
  const locality = componentWithType(components, [
    "locality",
    "postal_town",
    "administrative_area_level_3",
  ]);
  // The PROVINCE/STATE, and level_1 wins outright rather than by component
  // order. Asking for both at once returns whichever the provider happened
  // to list first, and for Toronto that is level_2 — which is also spelled
  // "Toronto". So the city's "region" came back as the city's own name,
  // which then went into the query suffix and the region check: the
  // locality rule this change removes was still running, wearing a region's
  // clothes. Live proof (2026-08-13): an Oakville start was refused as a
  // different region, and a Hamilton address was relocated INTO Toronto by
  // the suffix. Level_2 survives only as the fallback for the countries
  // that have no level_1 at all.
  const administrativeArea =
    componentWithType(components, ["administrative_area_level_1"]) ??
    componentWithType(components, ["administrative_area_level_2"]);
  const country = componentWithType(components, ["country"]);
  if (country && !/^[A-Za-z]{2}$/.test(country.shortName)) invalidProvider();
  const placeId =
    value.place_id === undefined
      ? undefined
      : validText(value.place_id)
        ? value.place_id
        : invalidProvider();

  return {
    candidate: {
      label: value.formatted_address,
      formattedAddress: value.formatted_address,
      location,
      timeZone: zoneFromLatLng(location.latitude, location.longitude),
      locality: locality?.longName ?? "",
      administrativeArea: administrativeArea?.longName,
      country: country?.longName ?? "",
      countryCode: country?.shortName.toUpperCase() ?? "",
      resultTypes: types,
      bounds: parseProviderBounds(value.geometry.viewport),
      placeId,
    },
    components,
    partial: value.partial_match === true,
  };
}

function hasAcceptedType(types: string[], accepted: Set<string>): boolean {
  return types.some((type) => accepted.has(type));
}

function matchesComponent(
  components: ParsedComponent[],
  expected: string,
  types: string[]
): boolean {
  const target = normalized(expected);
  return components.some(
    (component) =>
      types.some((type) => component.types.includes(type)) &&
      (normalized(component.longName) === target ||
        normalized(component.shortName) === target)
  );
}

function dedupeCandidates(results: ParsedResult[]): GeocodeCandidate[] {
  const seen = new Set<string>();
  const candidates: GeocodeCandidate[] = [];
  for (const { candidate } of results) {
    const key =
      candidate.placeId ??
      [
        normalized(candidate.formattedAddress),
        candidate.location.latitude.toFixed(6),
        candidate.location.longitude.toFixed(6),
      ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

function resolveCandidates(
  queryType: GeocodeQueryType,
  candidates: GeocodeCandidate[]
): GeocodeOutcome {
  if (candidates.length === 1) {
    return {
      outcome: "resolved",
      queryType,
      ...candidates[0],
    };
  }
  return {
    outcome: "ambiguous",
    queryType,
    code: "geocode_ambiguous",
    message:
      queryType === "city"
        ? "More than one city matched. Choose the city you meant."
        : "More than one starting address matched. Choose the address you meant.",
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
}

function noResult(): never {
  throw new ApiError(
    404,
    "geocode_not_found",
    "Couldn't find that location. Check the spelling and include a region or country."
  );
}

/**
 * COORDINATE -> LABEL, for the starting location field's "Use current
 * location" row. Three things make this branch different from the address
 * branch, and all three are deliberate.
 *
 * 1. THE ACCEPTANCE IS RELAXED. A real device fix lands wherever the person
 *    is standing, which is regularly a park, a highway, a campus, or a
 *    street the provider only knows as a `route`. The address branch calls
 *    every one of those an incomplete address and refuses it, correctly, for
 *    something a user TYPED. Refusing them here would refuse a point we
 *    actually know, because of how it is spelled.
 *
 * 2. THE COORDINATE NEVER MOVES. The label is whatever the provider calls
 *    the point; the LOCATION returned is the device's own reading, byte for
 *    byte, and the timezone is derived from that same reading. A reverse
 *    result's coordinate is the centroid of whatever feature matched, which
 *    can be a block or a suburb away. The device knows where it is; the
 *    provider is only being asked for a name.
 *
 * 3. NO NAME IS STILL A RESULT. When nothing parses, this returns a
 *    candidate with empty text rather than a 404. The caller supplies the
 *    plain fallback wording, because a missing LABEL is no reason to throw
 *    away a good coordinate.
 *
 * The two SANITY checks are NOT relaxed. When a city context is supplied,
 * the country test and `judgeStartProximity` run exactly as they do for a
 * typed address, through the same function and the same constants, so a
 * plan can never start 400 km from the city it is planning.
 */
function resolveReverseGeocode(
  data: Record<string, unknown>,
  request: GeocodeRequest
): ResolvedGeocode {
  const device = request.location;
  if (!device) {
    throw new ApiError(
      400,
      "invalid_query",
      "A reverse lookup needs a `location`."
    );
  }

  // The first result the provider can produce cleanly. Google orders these
  // most specific first, so "first" is "best named". A single odd entry is
  // skipped rather than failing the lookup: this is a label, and the
  // coordinate behind it is already good.
  let named: ParsedResult | null = null;
  if (Array.isArray(data.results) && data.results.length <= MAX_PROVIDER_RESULTS) {
    for (const raw of data.results) {
      try {
        const parsed = parseResult(raw);
        if (parsed.candidate.formattedAddress.trim().length > 0) {
          named = parsed;
          break;
        }
      } catch {
        // an unreadable entry is not a reason to lose the coordinate
      }
    }
  }

  const components = named?.components ?? [];
  const candidate: GeocodeCandidate = {
    label: named?.candidate.label ?? "",
    formattedAddress: named?.candidate.formattedAddress ?? "",
    // the device's reading, verbatim, and its zone
    location: device,
    timeZone: zoneFromLatLng(device.latitude, device.longitude),
    locality: named?.candidate.locality ?? "",
    administrativeArea: named?.candidate.administrativeArea,
    country: named?.candidate.country ?? "",
    countryCode: named?.candidate.countryCode ?? "",
    resultTypes: named?.candidate.resultTypes ?? [],
    // deliberately no `bounds`: a matched feature's viewport describes that
    // feature, not the person standing inside it
    placeId: named?.candidate.placeId,
  };

  const context = request.cityContext;
  if (context) {
    // Only checkable when the provider named a country. Keep-on-missing:
    // an unnamed point is judged by distance alone, which is the stronger
    // test anyway.
    if (
      candidate.countryCode &&
      normalized(candidate.countryCode) !== normalized(context.countryCode)
    ) {
      throw new ApiError(
        422,
        "geocode_wrong_country",
        "Your current location is outside the selected city's country. Check the city, or type a starting address."
      );
    }
    const regionMatches =
      !context.administrativeArea ||
      components.length === 0 ||
      matchesComponent(components, context.administrativeArea, [
        "administrative_area_level_1",
        "administrative_area_level_2",
      ]);
    const proximity = judgeStartProximity(
      device,
      context.location,
      regionMatches
    );
    if (proximity === "too-far") {
      throw new ApiError(
        422,
        "geocode_far_from_city",
        `Your current location is very far from ${context.locality}. Check the city, or type a starting address.`
      );
    }
    if (proximity === "wrong-region") {
      throw new ApiError(
        422,
        "geocode_outside_city",
        `Your current location is in a different region than ${context.locality}. Check the city, or type a starting address.`
      );
    }
  }

  return { outcome: "resolved", queryType: "reverse", ...candidate };
}

export function resolveGeocodeResponse(
  value: unknown,
  request: GeocodeRequest
): GeocodeOutcome {
  const data = requireProviderRecord("geocoding", value);
  if (!validText(data.status)) invalidProvider();
  if (request.kind === "reverse") {
    // ZERO_RESULTS is a legitimate answer for a coordinate (an unnamed spot
    // is still a spot), so only a genuine provider rejection throws here.
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      throw new ProviderError("geocoding", 502, "geocoding_rejected_request");
    }
    return resolveReverseGeocode(data, request);
  }
  if (data.status === "ZERO_RESULTS") noResult();
  if (data.status !== "OK") {
    throw new ProviderError("geocoding", 502, "geocoding_rejected_request");
  }
  if (
    !Array.isArray(data.results) ||
    data.results.length === 0 ||
    data.results.length > MAX_PROVIDER_RESULTS
  ) {
    if (Array.isArray(data.results) && data.results.length === 0) noResult();
    invalidProvider();
  }
  const results = data.results.map(parseResult);

  if (request.kind === "city") {
    const candidates = dedupeCandidates(
      results.filter(
        ({ candidate }) =>
          hasAcceptedType(candidate.resultTypes, CITY_RESULT_TYPES) &&
          Boolean(candidate.locality) &&
          Boolean(candidate.country) &&
          /^[A-Z]{2}$/.test(candidate.countryCode)
      )
    );
    if (candidates.length === 0) noResult();
    return resolveCandidates("city", candidates);
  }

  const context = request.cityContext;
  if (!context) {
    throw new ApiError(
      400,
      "city_context_required",
      "An address must be resolved within a selected city."
    );
  }

  let incomplete = false;
  let wrongCountry = false;
  let wrongRegion = false;
  let tooFar = false;
  const valid: ParsedResult[] = [];
  for (const result of results) {
    const { candidate, components, partial } = result;
    const routeOnly =
      candidate.resultTypes.includes("route") &&
      !hasAcceptedType(candidate.resultTypes, ADDRESS_RESULT_TYPES);
    const missingStreetNumber =
      (candidate.resultTypes.includes("street_address") ||
        candidate.resultTypes.includes("subpremise")) &&
      !componentWithType(components, ["street_number"]);
    if (partial || routeOnly || missingStreetNumber) {
      incomplete = true;
      continue;
    }
    if (!hasAcceptedType(candidate.resultTypes, ADDRESS_RESULT_TYPES)) continue;
    if (
      !candidate.countryCode ||
      normalized(candidate.countryCode) !== normalized(context.countryCode)
    ) {
      wrongCountry = true;
      continue;
    }
    // The start does NOT have to be in the selected city. It has to be
    // near enough to it to be a day's start there — which is a DISTANCE,
    // a fact code owns, not a locality-name equality. Name equality used
    // to decide this, and it refused every commuter suburb while passing
    // any same-named place the country check let through.
    const regionMatches =
      !context.administrativeArea ||
      matchesComponent(components, context.administrativeArea, [
        "administrative_area_level_1",
        "administrative_area_level_2",
      ]);
    const proximity = judgeStartProximity(
      candidate.location,
      context.location,
      regionMatches
    );
    if (proximity === "too-far") {
      tooFar = true;
      continue;
    }
    if (proximity === "wrong-region") {
      wrongRegion = true;
      continue;
    }
    valid.push(result);
  }

  const candidates = dedupeCandidates(valid);
  if (candidates.length > 0) return resolveCandidates("address", candidates);
  if (wrongCountry) {
    throw new ApiError(
      422,
      "geocode_wrong_country",
      "That address resolved outside the selected city's country. Add a postal code or choose a more specific address."
    );
  }
  if (tooFar) {
    throw new ApiError(
      422,
      "geocode_far_from_city",
      `That address is very far from ${context.locality}, check the city or the address.`
    );
  }
  if (wrongRegion) {
    throw new ApiError(
      422,
      "geocode_outside_city",
      `That address is in a different region than ${context.locality}. Check the city or add a postal code.`
    );
  }
  if (incomplete) {
    throw new ApiError(
      422,
      "geocode_incomplete_address",
      "That looks like a street rather than a complete starting address. Add a street number or landmark."
    );
  }
  noResult();
}
