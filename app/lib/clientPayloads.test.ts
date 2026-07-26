import assert from "node:assert";
import {
  parseCreatePayload,
  parseGeocodePayload,
  parseItineraryPayload,
  parsePlacesPayload,
  parseReroutePayload,
  parseSelectionsPayload,
  parseSwapPayload,
  parseTravelPayload,
  parseWeatherPayload,
} from "./clientPayloads";

const walkLeg = {
  fromIndex: 0,
  mode: "walk",
  rawMinutes: 7,
  marginMinutes: 0,
  totalMinutes: 7,
  distanceMeters: 540,
  encodedPolyline: null,
};

const transitSummary = {
  lineName: "501 Queen",
  shortName: "501",
  color: "#d71920",
  textColor: "#ffffff",
  vehicle: "TRAM",
  headsign: "Long Branch",
  stopCount: 9,
  departStop: "Queen St West",
  arriveStop: "Ossington Ave",
};

const transitLeg = {
  fromIndex: -1,
  mode: "transit",
  rawMinutes: 22,
  marginMinutes: 5,
  totalMinutes: 27,
  distanceMeters: 5_200,
  encodedPolyline: "encoded-home-leg",
  transit: transitSummary,
  transitSegments: [transitSummary],
};

const unknownLeg = {
  fromIndex: 1,
  mode: "unknown",
  rawMinutes: 0,
  marginMinutes: 0,
  totalMinutes: 0,
  distanceMeters: null,
  encodedPolyline: null,
};

const cases: Array<[string, () => void]> = [
  [
    "accepts the bounded success shapes used by every planning stage",
    () => {
      assert.deepStrictEqual(
        parseGeocodePayload({
          label: "Toronto",
          location: { latitude: 43.65, longitude: -79.38 },
          timeZone: "America/Toronto",
        }).location,
        { latitude: 43.65, longitude: -79.38 }
      );
      assert.strictEqual(
        parsePlacesPayload({
          dinner: [{ id: "dinner-1" }],
          _dropLog: [],
          _weatherBlocked: [],
        }).pools.dinner[0].id,
        "dinner-1"
      );
      assert.strictEqual(
        parseSelectionsPayload({
          selections: [
            { category: "dinner", slot: 0, id: "dinner-1", reason: "Fits." },
          ],
        }).selections[0].slot,
        0
      );
      assert.strictEqual(
        parseTravelPayload({ legs: [walkLeg] })
          .legs[0].totalMinutes,
        7
      );
      assert.strictEqual(parseCreatePayload({ id: "plan-1", version: 1 }).id, "plan-1");
    },
  ],
  [
    "travel validation accepts the honest unknown fallback and checks the full leg contract",
    () => {
      assert.strictEqual(
        parseTravelPayload({ legs: [unknownLeg] }).legs[0].mode,
        "unknown"
      );
      assert.strictEqual(
        parseTravelPayload({ legs: [transitLeg] }).legs[0].transit?.shortName,
        "501"
      );
      assert.throws(() =>
        parseTravelPayload({
          legs: [{ mode: "walk", totalMinutes: 7 }],
        })
      );
      assert.throws(() =>
        parseTravelPayload({
          legs: [
            {
              ...transitLeg,
              transitSegments: [{ ...transitSummary, stopCount: -1 }],
            },
          ],
        })
      );
    },
  ],
  [
    "weather validation rejects a corrupt hour instead of keeping stale data",
    () => {
      assert.throws(() =>
        parseWeatherPayload([
          {
            hourISO: 123,
            tempC: 20,
            precipProbability: null,
            condition: "Clear",
          },
        ])
      );
    },
  ],
  [
    "places validation rejects malformed pools and metadata",
    () => {
      assert.throws(() =>
        parsePlacesPayload({
          dinner: "not-an-array",
          _dropLog: [],
          _weatherBlocked: [],
        })
      );
      assert.throws(() =>
        parsePlacesPayload({
          dinner: [],
          _dropLog: [{ category: "dinner" }],
          _weatherBlocked: [],
        })
      );
    },
  ],
  [
    "itinerary validation checks the nested stops consumed by the UI",
    () => {
      const valid = {
        id: "plan-1",
        version: 2,
        createdAt: "2026-07-25T00:00:00.000Z",
        status: "active",
        stops: [
          {
            category: "dinner",
            id: "dinner-1",
            status: "upcoming",
            locked: false,
            start_time: "2026-07-25T23:00:00.000Z",
            end_time: "2026-07-26T00:00:00.000Z",
            durationMinutes: { base: 45, buffer: 15, total: 60 },
            location: { latitude: 43.65, longitude: -79.42 },
            currentOpeningHours: {
              openNow: true,
              periods: [
                {
                  open: { day: 6, hour: 17, minute: 0 },
                  close: { day: 0, hour: 2, minute: 0 },
                },
              ],
            },
            travelMinutesToNext: 7,
            travelToNext: walkLeg,
          },
        ],
        legs: [walkLeg],
        homeLeg: transitLeg,
        home: {
          label: "Start · Queen Street",
          location: { latitude: 43.65, longitude: -79.42 },
        },
        timeZone: "America/Toronto",
        parsed: {
          time_window: "7pm",
          stop_count: 1,
          aesthetic: "",
          category_signals: ["dinner"],
          group_context: "",
          budget: null,
          constraints: [],
          location: "Ossington",
          city: "Toronto",
          home: { latitude: 43.65, longitude: -79.42 },
        },
      };
      assert.strictEqual(parseItineraryPayload(valid).id, "plan-1");
      assert.throws(() =>
        parseItineraryPayload({
          ...valid,
          stops: [{ ...valid.stops[0], locked: "false" }],
        })
      );
      assert.throws(() =>
        parseItineraryPayload({
          ...valid,
          stops: [{ ...valid.stops[0], location: "bad coordinates" }],
        })
      );
      assert.throws(() =>
        parseItineraryPayload({
          ...valid,
          stops: [
            {
              ...valid.stops[0],
              travelToNext: { mode: "walk", totalMinutes: 7 },
            },
          ],
        })
      );
      assert.throws(() =>
        parseItineraryPayload({
          ...valid,
          stops: [
            {
              ...valid.stops[0],
              durationMinutes: undefined,
            },
          ],
        })
      );
      assert.throws(() =>
        parseItineraryPayload({
          ...valid,
          stops: [
            {
              ...valid.stops[0],
              currentOpeningHours: {
                periods: [{ open: { day: 7, hour: 17, minute: 0 } }],
              },
            },
          ],
        })
      );
      assert.throws(() => parseItineraryPayload({ ...valid, home: {} }));
      assert.throws(() =>
        parseItineraryPayload({ ...valid, timeZone: "Not/AZone" })
      );
      assert.throws(() =>
        parseItineraryPayload({
          ...valid,
          homeLeg: {
            ...transitLeg,
            transit: { ...transitSummary, shortName: undefined },
          },
        })
      );
      assert.throws(() =>
        parseItineraryPayload({
          ...valid,
          parsed: { ...valid.parsed, home: "bad coordinates" },
        })
      );
    },
  ],
  [
    "reroute validation keeps success and refusal branches distinct",
    () => {
      assert.deepStrictEqual(
        parseReroutePayload({ rerouted: false, reason: "Nothing downstream." }),
        { rerouted: false, reason: "Nothing downstream." }
      );
      assert.strictEqual(
        parseReroutePayload({
          rerouted: true,
          floor_time: "2026-07-25T23:00:00.000Z",
          anchor_time: "2026-07-25T23:30:00.000Z",
          changed: [{ stopIndex: 1, before: { start: null } }],
        }).rerouted,
        true
      );
      assert.throws(() =>
        parseReroutePayload({
          rerouted: true,
          floor_time: "2026-07-25T23:00:00.000Z",
          changed: "bad",
        })
      );
    },
  ],
  [
    "swap validation rejects incomplete success payloads",
    () => {
      assert.deepStrictEqual(
        parseSwapPayload({ swapped: false, reason: "Kept the original." }),
        { swapped: false, reason: "Kept the original." }
      );
      assert.throws(() =>
        parseSwapPayload({
          swapped: true,
          reason: "Changed.",
          stopIndex: 0,
          path: "research",
          downstreamShifted: [],
        })
      );
    },
  ],
];

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
