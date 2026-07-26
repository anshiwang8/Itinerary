import { zoneFromLatLng } from "../../lib/zoneTime";
import {
  ApiError,
  REQUEST_LIMITS,
  isRecord,
  validLatitude,
  validLongitude,
} from "../_shared/http";
import { ProviderError, requireProviderRecord } from "../_shared/provider";

const GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const MAX_PROVIDER_RESULTS = 50;
const MAX_CANDIDATES = 5;

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

export type GeocodeQueryType = "city" | "address";

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
  query: string;
  kind: GeocodeQueryType;
  cityContext?: CityContext;
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
    typeof value.query !== "string" ||
    value.query.trim().length === 0 ||
    value.query.length > REQUEST_LIMITS.promptChars ||
    (value.kind !== "city" && value.kind !== "address")
  ) {
    throw new ApiError(
      400,
      "invalid_query",
      `\`query\` must be a non-empty string no longer than ${REQUEST_LIMITS.promptChars} characters, and \`kind\` must be "city" or "address".`
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
  let address = request.query;
  if (request.kind === "address" && request.cityContext) {
    const context = request.cityContext;
    const suffix = [
      context.locality,
      context.administrativeArea,
      context.country,
    ].filter((part): part is string => Boolean(part));
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
  const administrativeArea = componentWithType(components, [
    "administrative_area_level_1",
    "administrative_area_level_2",
  ]);
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

export function resolveGeocodeResponse(
  value: unknown,
  request: GeocodeRequest
): GeocodeOutcome {
  const data = requireProviderRecord("geocoding", value);
  if (!validText(data.status)) invalidProvider();
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
  let outsideCity = false;
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
    if (
      !candidate.locality ||
      !matchesComponent(components, context.locality, [
        "locality",
        "postal_town",
        "administrative_area_level_3",
      ])
    ) {
      outsideCity = true;
      continue;
    }
    if (
      context.administrativeArea &&
      !matchesComponent(components, context.administrativeArea, [
        "administrative_area_level_1",
        "administrative_area_level_2",
      ])
    ) {
      outsideCity = true;
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
  if (outsideCity) {
    throw new ApiError(
      422,
      "geocode_outside_city",
      "That address did not resolve within the selected city. Check the city or add a postal code."
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
