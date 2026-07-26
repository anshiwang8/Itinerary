import assert from "node:assert";
import { NextRequest } from "next/server";
import { resetRateLimitsForTests, ApiError } from "../_shared/http";
import { POST } from "./route";
import {
  CityContext,
  GeocodeRequest,
  buildGeocodeUrl,
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
      assert.strictEqual(
        url.searchParams.get("address"),
        "100 Queen Street West, Toronto, Ontario, Canada"
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
