import assert from "node:assert";
import { NextRequest } from "next/server";
import { resetRateLimitsForTests, ApiError } from "../_shared/http";
import { POST } from "./route";
import {
  CityContext,
  GeocodeRequest,
  MAX_START_DISTANCE_FROM_CITY_METERS,
  SAME_METRO_METERS,
  buildGeocodeUrl,
  judgeStartProximity,
  parseGeocodeRequest,
  resolveGeocodeResponse,
} from "./geocode";

const toronto: CityContext = {
  locality: "Toronto",
  administrativeArea: "Ontario",
  country: "Canada",
  countryCode: "CA",
  location: { latitude: 43.6532, longitude: -79.3832 },
  bounds: {
    southwest: { latitude: 43.581, longitude: -79.639 },
    northeast: { latitude: 43.855, longitude: -79.116 },
  },
};

// The geocode distance-reordering fix's own realistic reproduction: the
// agent-persona BREAK harness's `boundary-start-montreal-cross-region-far`
// scenario, run live against the deployed app on 2026-09-22.
const ottawa: CityContext = {
  locality: "Ottawa",
  administrativeArea: "Ontario",
  country: "Canada",
  countryCode: "CA",
  location: { latitude: 45.4215, longitude: -75.6972 },
  bounds: {
    southwest: { latitude: 45.2, longitude: -75.95 },
    northeast: { latitude: 45.55, longitude: -75.35 },
  },
};

const cityRequest: GeocodeRequest = { query: "London", kind: "city" };
const addressRequest: GeocodeRequest = {
  query: "100 Queen Street West",
  kind: "address",
  cityContext: toronto,
};

// The rule's own haversine, run backwards: a point exactly `meters` due
// north of Toronto's centre. Boundary cases are then exact rather than
// approximately-a-suburb, so "75 km is allowed, past it is not" is pinned
// on both sides instead of near it.
const EARTH_RADIUS_METERS = 6_371_000;
function northOfCity(meters: number): { lat: number; lng: number } {
  return {
    lat:
      toronto.location.latitude +
      (meters * 180) / (Math.PI * EARTH_RADIUS_METERS),
    lng: toronto.location.longitude,
  };
}

function component(
  longName: string,
  shortName: string,
  ...types: string[]
): Record<string, unknown> {
  return { long_name: longName, short_name: shortName, types };
}

function result(options: {
  formatted: string;
  types: string[];
  locality?: string;
  admin?: string;
  country?: string;
  countryCode?: string;
  lat?: number;
  lng?: number;
  partial?: boolean;
  placeId?: string;
  includeStreetNumber?: boolean;
}): Record<string, unknown> {
  const locality = options.locality ?? "Toronto";
  const admin = options.admin ?? "Ontario";
  const country = options.country ?? "Canada";
  const countryCode = options.countryCode ?? "CA";
  return {
    formatted_address: options.formatted,
    place_id: options.placeId ?? options.formatted,
    partial_match: options.partial,
    types: options.types,
    address_components: [
      ...(options.includeStreetNumber === false
        ? []
        : [component("100", "100", "street_number")]),
      component("Queen Street West", "Queen St W", "route"),
      component(locality, locality, "locality", "political"),
      component(admin, admin === "Ontario" ? "ON" : admin, "administrative_area_level_1", "political"),
      component(country, countryCode, "country", "political"),
    ],
    geometry: {
      location: {
        lat: options.lat ?? 43.6532,
        lng: options.lng ?? -79.3832,
      },
      location_type: options.types.includes("locality") ? "APPROXIMATE" : "ROOFTOP",
      viewport: {
        southwest: { lat: 43.58, lng: -79.64 },
        northeast: { lat: 43.86, lng: -79.11 },
      },
    },
  };
}

function response(results: Record<string, unknown>[]): Record<string, unknown> {
  return { status: "OK", results };
}

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/geocode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A device fix somewhere in downtown Toronto. */
const deviceFix = { latitude: 43.6547, longitude: -79.3862 };
function reverseRequest(cityContext?: CityContext): GeocodeRequest {
  const value: GeocodeRequest = {
    query: "",
    kind: "reverse",
    location: deviceFix,
  };
  if (cityContext) value.cityContext = cityContext;
  return value;
}

const cases: Array<[string, () => void | Promise<void>]> = [
  // ── reverse (coordinate -> label), the "Use current location" path ──
  [
    "reverse accepts a route-only result the ADDRESS branch would refuse",
    () => {
      // This exact result shape (a `route` with no street_number) is what
      // `geocode_incomplete_address` exists to reject for typed text. A real
      // device fix lands on one constantly, and refusing it would throw away
      // a coordinate we actually know because of how it is spelled.
      const outcome = resolveGeocodeResponse(
        response([
          result({
            formatted: "Chestnut St, Toronto, ON, Canada",
            types: ["route"],
            includeStreetNumber: false,
          }),
        ]),
        reverseRequest()
      );
      assert.strictEqual(outcome.outcome, "resolved");
      assert.strictEqual(outcome.queryType, "reverse");
      if (outcome.outcome !== "resolved") return;
      assert.strictEqual(outcome.formattedAddress, "Chestnut St, Toronto, ON, Canada");
    },
  ],
  [
    "reverse returns the DEVICE coordinate, never the matched feature's centroid",
    () => {
      // The provider's own `geometry.location` is deliberately far from the
      // fix here: a reverse result's coordinate is the centre of whatever
      // feature matched, and the device is the one that knows where it is.
      const outcome = resolveGeocodeResponse(
        response([
          result({
            formatted: "Yonge St, Toronto, ON, Canada",
            types: ["route"],
            includeStreetNumber: false,
            lat: 43.7,
            lng: -79.4,
          }),
        ]),
        reverseRequest()
      );
      if (outcome.outcome !== "resolved") throw new Error("expected resolved");
      assert.deepStrictEqual(outcome.location, deviceFix);
      // and the zone follows the device coordinate, not the feature's
      assert.strictEqual(outcome.timeZone, "America/Toronto");
    },
  ],
  [
    "reverse with no usable result returns empty text, not a 404",
    () => {
      const zero = resolveGeocodeResponse(
        { status: "ZERO_RESULTS", results: [] },
        reverseRequest()
      );
      if (zero.outcome !== "resolved") throw new Error("expected resolved");
      assert.strictEqual(zero.formattedAddress, "");
      assert.strictEqual(zero.label, "");
      assert.deepStrictEqual(zero.location, deviceFix);
      // an unreadable entry is skipped rather than losing the coordinate
      const junk = resolveGeocodeResponse(
        { status: "OK", results: [{ formatted_address: 7 }] },
        reverseRequest()
      );
      if (junk.outcome !== "resolved") throw new Error("expected resolved");
      assert.strictEqual(junk.formattedAddress, "");
      assert.deepStrictEqual(junk.location, deviceFix);
    },
  ],
  [
    "reverse still refuses a fix past the city distance cap, on the SAME rule",
    () => {
      const far = northOfCity(MAX_START_DISTANCE_FROM_CITY_METERS + 2_000);
      const request: GeocodeRequest = {
        query: "",
        kind: "reverse",
        location: { latitude: far.lat, longitude: far.lng },
        cityContext: toronto,
      };
      assert.throws(
        () =>
          resolveGeocodeResponse(
            response([
              result({
                formatted: "Somewhere far, ON, Canada",
                types: ["route"],
                includeStreetNumber: false,
                lat: far.lat,
                lng: far.lng,
              }),
            ]),
            request
          ),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 422 &&
          error.code === "geocode_far_from_city"
      );
    },
  ],
  [
    "reverse still refuses a fix in another country",
    () => {
      assert.throws(
        () =>
          resolveGeocodeResponse(
            response([
              result({
                formatted: "Buffalo, NY, USA",
                types: ["route"],
                includeStreetNumber: false,
                locality: "Buffalo",
                admin: "New York",
                country: "United States",
                countryCode: "US",
              }),
            ]),
            reverseRequest(toronto)
          ),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 422 &&
          error.code === "geocode_wrong_country"
      );
    },
  ],
  [
    "an unnamed reverse fix inside the city still passes: distance alone decides",
    () => {
      const outcome = resolveGeocodeResponse(
        { status: "ZERO_RESULTS", results: [] },
        reverseRequest(toronto)
      );
      assert.strictEqual(outcome.outcome, "resolved");
    },
  ],
  [
    "reverse builds a latlng URL with no text-disambiguation parameters",
    () => {
      const url = buildGeocodeUrl(reverseRequest(toronto), "KEY");
      assert.strictEqual(url.searchParams.get("latlng"), "43.6547,-79.3862");
      assert.strictEqual(url.searchParams.get("address"), null);
      // bounds/components/region exist to disambiguate TEXT; a coordinate
      // names exactly one point, and a country filter here would hide the
      // wrong-country result the check above is meant to report.
      assert.strictEqual(url.searchParams.get("bounds"), null);
      assert.strictEqual(url.searchParams.get("components"), null);
      assert.strictEqual(url.searchParams.get("region"), null);
    },
  ],
  [
    "a reverse request needs a location, and a provider rejection still throws",
    () => {
      assert.throws(
        () => parseGeocodeRequest({ kind: "reverse" }),
        (error: unknown) => error instanceof ApiError && error.status === 400
      );
      assert.throws(
        () =>
          parseGeocodeRequest({
            kind: "reverse",
            location: { latitude: 200, longitude: 0 },
          }),
        (error: unknown) => error instanceof ApiError && error.status === 400
      );
      // ZERO_RESULTS is a legitimate answer for a point; a real rejection
      // is not, and must not be laundered into a blank label.
      assert.throws(() =>
        resolveGeocodeResponse({ status: "REQUEST_DENIED" }, reverseRequest())
      );
    },
  ],

  [
    "ambiguous city returns bounded formatted-address candidates instead of index zero",
    () => {
      const outcome = resolveGeocodeResponse(
        response([
          result({
            formatted: "London, ON, Canada",
            types: ["locality", "political"],
            locality: "London",
            admin: "Ontario",
            placeId: "london-ca",
          }),
          result({
            formatted: "London, UK",
            types: ["locality", "political"],
            locality: "London",
            admin: "England",
            country: "United Kingdom",
            countryCode: "GB",
            lat: 51.5072,
            lng: -0.1276,
            placeId: "london-gb",
          }),
        ]),
        cityRequest
      );
      assert.strictEqual(outcome.outcome, "ambiguous");
      if (outcome.outcome !== "ambiguous") return;
      assert.deepStrictEqual(
        outcome.candidates.map((candidate) => candidate.formattedAddress),
        ["London, ON, Canada", "London, UK"]
      );
    },
  ],
  [
    "a business sharing the city name is ignored in favour of a typed locality",
    () => {
      const outcome = resolveGeocodeResponse(
        response([
          result({
            formatted: "London Cafe, London, ON, Canada",
            types: ["establishment", "food", "point_of_interest"],
            locality: "London",
            placeId: "london-cafe",
          }),
          result({
            formatted: "London, ON, Canada",
            types: ["locality", "political"],
            locality: "London",
            placeId: "london-city",
          }),
        ]),
        cityRequest
      );
      assert.strictEqual(outcome.outcome, "resolved");
      if (outcome.outcome !== "resolved") return;
      assert.strictEqual(outcome.formattedAddress, "London, ON, Canada");
      assert.deepStrictEqual(outcome.resultTypes, ["locality", "political"]);
    },
  ],
  [
    "an incomplete street result fails honestly instead of using its midpoint",
    () => {
      assert.throws(
        () =>
          resolveGeocodeResponse(
            response([
              result({
                formatted: "Queen Street West, Toronto, ON, Canada",
                types: ["street_address"],
                includeStreetNumber: false,
              }),
            ]),
            addressRequest
          ),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 422 &&
          error.code === "geocode_incomplete_address"
      );
    },
  ],
  [
    "an address in the wrong country is rejected even when Google also flags it a partial match",
    () => {
      // A REAL provider response shape (Finding D, live probe row B), not
      // the dead one this replaced. With the hard `components=country:CA`
      // filter gone, the request's ", Ontario, Canada" text suffix alone is
      // what disambiguates in-country addresses — but that same suffix
      // independently makes Google mark a genuine cross-border result
      // `partial_match: true`, even with a complete street number. Before
      // the country check ran first, this exact shape short-circuited into
      // `geocode_incomplete_address` ("looks like a street") and the
      // cross-border fact was never recorded at all.
      assert.throws(
        () =>
          resolveGeocodeResponse(
            response([
              result({
                formatted: "100 Queen Street, Buffalo, NY, USA",
                types: ["street_address"],
                locality: "Buffalo",
                admin: "New York",
                country: "United States",
                countryCode: "US",
                lat: 42.8864,
                lng: -78.8784,
                partial: true,
              }),
            ]),
            addressRequest
          ),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 422 &&
          error.code === "geocode_wrong_country"
      );
    },
  ],
  [
    "an in-country address flagged only as a partial match still reaches incomplete, never wrong-country",
    () => {
      // The regression guard for the reorder above: a partial match whose
      // country genuinely agrees must still fall through to
      // geocode_incomplete_address, not get swept into wrongCountry by a
      // check that now runs first.
      assert.throws(
        () =>
          resolveGeocodeResponse(
            response([
              result({
                formatted: "100 Queen Street West, Toronto, ON, Canada",
                types: ["street_address"],
                partial: true,
              }),
            ]),
            addressRequest
          ),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 422 &&
          error.code === "geocode_incomplete_address"
      );
    },
  ],
  [
    "a same-country, over-distance address is refused for distance even when Google also flags it a partial match",
    () => {
      // The mirrored regression for the distance/region axis: the geocode
      // distance-reordering fix. Same live shape the agent-persona BREAK
      // harness found against the deployed app on 2026-09-22 (persona
      // `boundary-start-montreal-cross-region-far`) — a real Montreal
      // address, ~166 km from an Ottawa city context, was refused as
      // `geocode_incomplete_address` ("looks like a street") instead of
      // `geocode_far_from_city`. Same-country, so D12's country-check
      // reorder does not help here; this is the same query-suffix
      // `partial_match: true` artifact one axis over, on the distance/
      // region checks that were never re-audited when D12 shipped. Before
      // this fix, `incomplete` consumed the candidate first and `tooFar`
      // was never even computed.
      assert.throws(
        () =>
          resolveGeocodeResponse(
            response([
              result({
                formatted: "1 Place Ville Marie, Montreal, QC, Canada",
                types: ["street_address"],
                locality: "Montreal",
                admin: "Quebec",
                lat: 45.5017,
                lng: -73.5673,
                partial: true,
              }),
            ]),
            { query: "1 Place Ville Marie", kind: "address", cityContext: ottawa }
          ),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 422 &&
          error.code === "geocode_far_from_city"
      );
    },
  ],
  [
    "a same-country, wrong-region address within the distance cap is refused for region even when Google also flags it a partial match",
    () => {
      // The wrong-region sibling of the test above: past SAME_METRO_METERS
      // but still under the 75 km distance cap, so `tooFar` never fires and
      // the region signal is the one that has to survive the completeness
      // check now running after it.
      const across = northOfCity(SAME_METRO_METERS + 200);
      assert.throws(
        () =>
          resolveGeocodeResponse(
            response([
              result({
                formatted: "1 Rue Principale, Elsewhere, QC, Canada",
                types: ["street_address"],
                locality: "Elsewhere",
                admin: "Quebec",
                lat: across.lat,
                lng: across.lng,
                partial: true,
              }),
            ]),
            addressRequest
          ),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 422 &&
          error.code === "geocode_outside_city"
      );
    },
  ],
  [
    "a Windsor address near the US border still resolves in-country with no hard components filter",
    () => {
      // One of the investigation's border-adjacent probe cities. Distance
      // from Toronto is irrelevant here — Windsor is its OWN selected city,
      // and the point is that removing components=country:CA must not make
      // an ordinary in-country, near-the-border address start failing the
      // country/region checks it always passed.
      const windsor: CityContext = {
        locality: "Windsor",
        administrativeArea: "Ontario",
        country: "Canada",
        countryCode: "CA",
        location: { latitude: 42.3149, longitude: -83.0364 },
        bounds: {
          southwest: { latitude: 42.24, longitude: -83.13 },
          northeast: { latitude: 42.39, longitude: -82.9 },
        },
      };
      const outcome = resolveGeocodeResponse(
        response([
          result({
            formatted: "400 Ouellette Ave, Windsor, ON, Canada",
            types: ["street_address"],
            locality: "Windsor",
            lat: 42.3149,
            lng: -83.0364,
          }),
        ]),
        { query: "400 Ouellette Ave", kind: "address", cityContext: windsor }
      );
      assert.strictEqual(outcome.outcome, "resolved");
      if (outcome.outcome !== "resolved") return;
      assert.strictEqual(outcome.countryCode, "CA");
      assert.strictEqual(outcome.locality, "Windsor");
    },
  ],
  [
    "a standard Toronto address still resolves correctly with no hard components filter",
    () => {
      // Regression check named in the investigation: an ordinary in-country
      // address must be unaffected by dropping the components filter.
      const outcome = resolveGeocodeResponse(
        response([result({ formatted: "100 Queen Street West, Toronto, ON, Canada", types: ["street_address"] })]),
        addressRequest
      );
      assert.strictEqual(outcome.outcome, "resolved");
      if (outcome.outcome !== "resolved") return;
      assert.strictEqual(outcome.countryCode, "CA");
    },
  ],
  [
    "ZERO_RESULTS becomes an actionable 404",
    () => {
      assert.throws(
        () =>
          resolveGeocodeResponse(
            { status: "ZERO_RESULTS", results: [] },
            cityRequest
          ),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 404 &&
          error.code === "geocode_not_found"
      );
    },
  ],
  [
    "multiple valid in-city addresses return candidates rather than a silent first choice",
    () => {
      const outcome = resolveGeocodeResponse(
        response([
          result({
            formatted: "100 Queen St W, Toronto, ON, Canada",
            types: ["street_address"],
            placeId: "queen-100",
          }),
          result({
            formatted: "100 Queen St E, Toronto, ON, Canada",
            types: ["street_address"],
            lng: -79.37,
            placeId: "queen-100-east",
          }),
        ]),
        addressRequest
      );
      assert.strictEqual(outcome.outcome, "ambiguous");
      if (outcome.outcome !== "ambiguous") return;
      assert.strictEqual(outcome.queryType, "address");
      assert.strictEqual(outcome.candidates.length, 2);
    },
  ],
  [
    "address URL carries city viewport bias and a region hint, but no hard country filter",
    () => {
      const url = buildGeocodeUrl(addressRequest, "geocoding-only-key");
      assert.strictEqual(url.origin, "https://maps.googleapis.com");
      assert.strictEqual(url.pathname, "/maps/api/geocode/json");
      // The city's LOCALITY is deliberately absent: appending it turns a
      // suburb address into an in-city query (or a partial_match), so the
      // validator never sees the address it is meant to judge. Region +
      // country TEXT still disambiguate, and the viewport still biases
      // ranking.
      assert.strictEqual(
        url.searchParams.get("address"),
        "100 Queen Street West, Ontario, Canada"
      );
      assert.strictEqual(
        url.searchParams.get("bounds"),
        "43.581,-79.639|43.855,-79.116"
      );
      // Finding D: the hard `components=country:` filter is gone — it
      // suppressed genuine cross-border results instead of letting the
      // validation loop's wrongCountry branch report them honestly.
      assert.strictEqual(url.searchParams.get("components"), null);
      assert.strictEqual(url.searchParams.get("region"), "ca");
      assert.strictEqual(url.searchParams.get("key"), "geocoding-only-key");
    },
  ],
  [
    "a commuter suburb OUTSIDE the selected city is a valid starting address",
    () => {
      const mississauga = northOfCity(25_000);
      const outcome = resolveGeocodeResponse(
        response([
          result({
            formatted: "100 Elm Dr, Mississauga, ON, Canada",
            types: ["street_address"],
            locality: "Mississauga",
            lat: mississauga.lat,
            lng: mississauga.lng,
          }),
        ]),
        addressRequest
      );
      assert.strictEqual(outcome.outcome, "resolved");
      if (outcome.outcome !== "resolved") return;
      assert.strictEqual(outcome.locality, "Mississauga");
      assert.strictEqual(
        outcome.formattedAddress,
        "100 Elm Dr, Mississauga, ON, Canada"
      );
    },
  ],
  [
    "the distance boundary itself is allowed — exactly the cap is in range",
    () => {
      const edge = northOfCity(MAX_START_DISTANCE_FROM_CITY_METERS);
      const outcome = resolveGeocodeResponse(
        response([
          result({
            formatted: "1 Boundary Rd, Somewhere, ON, Canada",
            types: ["street_address"],
            locality: "Somewhere",
            lat: edge.lat,
            lng: edge.lng,
          }),
        ]),
        addressRequest
      );
      assert.strictEqual(outcome.outcome, "resolved");
    },
  ],
  [
    "a start beyond the distance cap is refused as far from the city",
    () => {
      const far = northOfCity(MAX_START_DISTANCE_FROM_CITY_METERS + 200);
      assert.throws(
        () =>
          resolveGeocodeResponse(
            response([
              result({
                formatted: "1 Main St, Faraway, ON, Canada",
                types: ["street_address"],
                locality: "Faraway",
                lat: far.lat,
                lng: far.lng,
              }),
            ]),
            addressRequest
          ),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 422 &&
          error.code === "geocode_far_from_city" &&
          // the refusal has to NAME the city, or "very far from where?"
          error.publicMessage.includes("Toronto")
      );
    },
  ],
  [
    "a different region is refused once it is outside the metro",
    () => {
      const across = northOfCity(SAME_METRO_METERS + 200);
      assert.throws(
        () =>
          resolveGeocodeResponse(
            response([
              result({
                formatted: "1 Rue Principale, Elsewhere, QC, Canada",
                types: ["street_address"],
                locality: "Elsewhere",
                admin: "Quebec",
                lat: across.lat,
                lng: across.lng,
              }),
            ]),
            addressRequest
          ),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 422 &&
          error.code === "geocode_outside_city"
      );
    },
  ],
  [
    "a different region INSIDE the metro still resolves — proximity outranks the region signal",
    () => {
      const nextDoor = northOfCity(5_000);
      const outcome = resolveGeocodeResponse(
        response([
          result({
            formatted: "1 Rue Laurier, Gatineau, QC, Canada",
            types: ["street_address"],
            locality: "Gatineau",
            admin: "Quebec",
            lat: nextDoor.lat,
            lng: nextDoor.lng,
          }),
        ]),
        addressRequest
      );
      assert.strictEqual(outcome.outcome, "resolved");
    },
  ],
  [
    "an out-of-city address and its in-city lookalike BOTH reach the candidate panel",
    () => {
      const suburb = northOfCity(20_000);
      const outcome = resolveGeocodeResponse(
        response([
          result({
            formatted: "100 Queen St W, Toronto, ON, Canada",
            types: ["street_address"],
            placeId: "queen-toronto",
          }),
          result({
            formatted: "100 Queen St W, Mississauga, ON, Canada",
            types: ["street_address"],
            locality: "Mississauga",
            lat: suburb.lat,
            lng: suburb.lng,
            placeId: "queen-mississauga",
          }),
        ]),
        addressRequest
      );
      // The locality rule used to silently reduce this to the in-city one.
      // Both are plausible now, so the choice belongs to the user.
      assert.strictEqual(outcome.outcome, "ambiguous");
      if (outcome.outcome !== "ambiguous") return;
      assert.deepStrictEqual(
        outcome.candidates.map((candidate) => candidate.formattedAddress),
        [
          "100 Queen St W, Toronto, ON, Canada",
          "100 Queen St W, Mississauga, ON, Canada",
        ]
      );
    },
  ],
  [
    "judgeStartProximity decides the whole rule on both sides of both thresholds",
    () => {
      const city = toronto.location;
      const at = (meters: number) => {
        const point = northOfCity(meters);
        return { latitude: point.lat, longitude: point.lng };
      };
      const cap = MAX_START_DISTANCE_FROM_CITY_METERS;
      assert.strictEqual(judgeStartProximity(at(0), city, true), "in-range");
      assert.strictEqual(judgeStartProximity(at(cap), city, true), "in-range");
      assert.strictEqual(judgeStartProximity(at(cap + 200), city, true), "too-far");
      // a region mismatch never turns a far address into a near one
      assert.strictEqual(judgeStartProximity(at(cap + 200), city, false), "too-far");
      // ...and inside the metro it is forgiven, because every near
      // cross-region address is a real suburb rather than a mistake
      assert.strictEqual(
        judgeStartProximity(at(SAME_METRO_METERS), city, false),
        "in-range"
      );
      assert.strictEqual(
        judgeStartProximity(at(SAME_METRO_METERS + 200), city, false),
        "wrong-region"
      );
    },
  ],
  [
    "the route calls Geocoding with its dedicated key and preserves the formatted address",
    async () => {
      resetRateLimitsForTests();
      const previousMock = process.env.E2E_MOCK;
      const previousGeocodingKey = process.env.GOOGLE_GEOCODING_API_KEY;
      const previousPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
      const realFetch = globalThis.fetch;
      delete process.env.E2E_MOCK;
      process.env.GOOGLE_GEOCODING_API_KEY = "dedicated-geocoding-key";
      process.env.GOOGLE_PLACES_API_KEY = "must-not-be-used";
      let requestedUrl: URL | undefined;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestedUrl = new URL(String(input));
        return new Response(
          JSON.stringify(
            response([
              result({
                formatted: "Toronto, ON, Canada",
                types: ["locality", "political"],
                locality: "Toronto",
              }),
            ])
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as typeof fetch;
      try {
        const routeResponse = await POST(
          request({ query: "Toronto", kind: "city" })
        );
        const body = await routeResponse.json();
        assert.strictEqual(routeResponse.status, 200);
        assert.strictEqual(body.formattedAddress, "Toronto, ON, Canada");
        assert.strictEqual(body.label, "Toronto, ON, Canada");
        assert.strictEqual(
          requestedUrl?.searchParams.get("key"),
          "dedicated-geocoding-key"
        );
        assert.ok(!String(requestedUrl).includes("must-not-be-used"));
      } finally {
        globalThis.fetch = realFetch;
        if (previousMock === undefined) delete process.env.E2E_MOCK;
        else process.env.E2E_MOCK = previousMock;
        if (previousGeocodingKey === undefined) {
          delete process.env.GOOGLE_GEOCODING_API_KEY;
        } else {
          process.env.GOOGLE_GEOCODING_API_KEY = previousGeocodingKey;
        }
        if (previousPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
        else process.env.GOOGLE_PLACES_API_KEY = previousPlacesKey;
        resetRateLimitsForTests();
      }
    },
  ],
  [
    "mock mode replaces provider data while retaining city and address validation",
    async () => {
      resetRateLimitsForTests();
      const previousMock = process.env.E2E_MOCK;
      process.env.E2E_MOCK = "1";
      try {
        const cityResponse = await POST(
          request({ query: "Vancouver", kind: "city" })
        );
        const city = await cityResponse.json();
        assert.strictEqual(cityResponse.status, 200);
        assert.strictEqual(city.outcome, "resolved");
        assert.deepStrictEqual(city.location, {
          latitude: 43.6547,
          longitude: -79.3862,
        });

        const addressResponse = await POST(
          request({
            query: "800 Robson Street",
            kind: "address",
            cityContext: city,
          })
        );
        const address = await addressResponse.json();
        assert.strictEqual(addressResponse.status, 200);
        assert.strictEqual(address.queryType, "address");
        assert.strictEqual(address.locality, "Vancouver");
        assert.strictEqual(address.label, "800 Robson Street (fixture)");
      } finally {
        if (previousMock === undefined) delete process.env.E2E_MOCK;
        else process.env.E2E_MOCK = previousMock;
        resetRateLimitsForTests();
      }
    },
  ],
];

async function main() {
  let failed = 0;
  for (const [name, test] of cases) {
    try {
      await test();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

void main();
