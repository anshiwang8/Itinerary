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

const cases: Array<[string, () => void | Promise<void>]> = [
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
    "an address in the wrong country is rejected against the selected city",
    () => {
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
    "address URL carries city viewport bias and a country restriction",
    () => {
      const url = buildGeocodeUrl(addressRequest, "geocoding-only-key");
      assert.strictEqual(url.origin, "https://maps.googleapis.com");
      assert.strictEqual(url.pathname, "/maps/api/geocode/json");
      // The city's LOCALITY is deliberately absent: appending it turns a
      // suburb address into an in-city query (or a partial_match), so the
      // validator never sees the address it is meant to judge. Region +
      // country still disambiguate, and the viewport still biases ranking.
      assert.strictEqual(
        url.searchParams.get("address"),
        "100 Queen Street West, Ontario, Canada"
      );
      assert.strictEqual(
        url.searchParams.get("bounds"),
        "43.581,-79.639|43.855,-79.116"
      );
      assert.strictEqual(url.searchParams.get("components"), "country:CA");
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
