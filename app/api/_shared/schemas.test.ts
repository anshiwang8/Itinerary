// Server-side travel-leg validation — the OTHER half of the project's
// "validate what crosses the wire" posture (the browser half lives in
// `clientPayloads.test.ts`). A leg arrives here from a client, is stored,
// and comes back out to be rendered and drawn on a map; the ride detail on
// it is now four more facts, so it is four more things to check.
// Run with: npx tsx app/api/_shared/schemas.test.ts
import assert from "node:assert";
import { parseTravelLegs } from "./schemas";

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

const rideWithTimes = {
  ...transitSummary,
  boardISO: "2026-07-03T23:07:00Z",
  alightISO: "2026-07-03T23:24:00Z",
  boardLocation: { latitude: 43.6501, longitude: -79.4204 },
  alightLocation: { latitude: 43.6624, longitude: -79.4262 },
};

const legWith = (ride: unknown) => [
  {
    fromIndex: 0,
    mode: "transit",
    rawMinutes: 22,
    marginMinutes: 5,
    totalMinutes: 27,
    distanceMeters: 5_200,
    encodedPolyline: "enc",
    transit: ride,
    transitSegments: [ride],
  },
];

const cases: Array<[string, () => void]> = [
  [
    "a leg carrying the provider's board/alight times and stop coordinates is accepted",
    () => {
      const legs = parseTravelLegs(legWith(rideWithTimes));
      assert.strictEqual(legs[0].transit?.boardISO, "2026-07-03T23:07:00Z");
      assert.deepStrictEqual(legs[0].transitSegments?.[0].boardLocation, {
        latitude: 43.6501,
        longitude: -79.4204,
      });
    },
  ],
  [
    "BACKWARD COMPAT: a ride WITHOUT the new fields still validates (every stored plan predates them)",
    () => {
      assert.strictEqual(parseTravelLegs(legWith(transitSummary)).length, 1);
      // and a walk leg, which has no ride at all
      assert.strictEqual(
        parseTravelLegs([
          {
            fromIndex: 1,
            mode: "walk",
            rawMinutes: 7,
            marginMinutes: 0,
            totalMinutes: 7,
            distanceMeters: 540,
            encodedPolyline: null,
          },
        ]).length,
        1
      );
      // ...and the honest unknown-estimate fallback
      assert.strictEqual(
        parseTravelLegs([
          {
            fromIndex: 2,
            mode: "unknown",
            rawMinutes: 12,
            marginMinutes: 5,
            totalMinutes: 17,
            distanceMeters: null,
            encodedPolyline: null,
          },
        ]).length,
        1
      );
    },
  ],
  [
    "an explicit null on any of the four is accepted — the agency published none",
    () => {
      const legs = parseTravelLegs(
        legWith({
          ...transitSummary,
          boardISO: null,
          alightISO: null,
          boardLocation: null,
          alightLocation: null,
        })
      );
      assert.strictEqual(legs[0].transit?.boardISO, null);
    },
  ],
  [
    "a malformed board time is rejected rather than stored and rendered",
    () => {
      assert.throws(() => parseTravelLegs(legWith({ ...transitSummary, boardISO: "soon" })));
      assert.throws(() => parseTravelLegs(legWith({ ...transitSummary, alightISO: 12345 })));
    },
  ],
  [
    "a malformed transfer coordinate is rejected — it would become a map marker",
    () => {
      assert.throws(() =>
        parseTravelLegs(legWith({ ...transitSummary, alightLocation: { latitude: 43.6, longitude: 900 } }))
      );
      assert.throws(() =>
        parseTravelLegs(legWith({ ...transitSummary, boardLocation: { latitude: 43.6 } }))
      );
      assert.throws(() =>
        parseTravelLegs(legWith({ ...transitSummary, boardLocation: "Ossington Station" }))
      );
    },
  ],
  [
    "transitSegments must be an array of ride objects",
    () => {
      assert.throws(() =>
        parseTravelLegs([
          {
            fromIndex: 0,
            mode: "transit",
            rawMinutes: 22,
            marginMinutes: 5,
            totalMinutes: 27,
            distanceMeters: 5_200,
            encodedPolyline: "enc",
            transitSegments: "501 Queen",
          },
        ])
      );
      assert.throws(() =>
        parseTravelLegs([
          {
            fromIndex: 0,
            mode: "transit",
            rawMinutes: 22,
            marginMinutes: 5,
            totalMinutes: 27,
            distanceMeters: 5_200,
            encodedPolyline: "enc",
            transitSegments: [null],
          },
        ])
      );
    },
  ],
  [
    "the leg contract it already enforced is untouched",
    () => {
      assert.deepStrictEqual(parseTravelLegs(undefined), []);
      assert.throws(() => parseTravelLegs([{ ...legWith(transitSummary)[0], mode: "teleport" }]));
      assert.throws(() => parseTravelLegs([{ ...legWith(transitSummary)[0], totalMinutes: -1 }]));
      assert.throws(() =>
        parseTravelLegs([{ ...legWith(transitSummary)[0], distanceMeters: -5 }])
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
