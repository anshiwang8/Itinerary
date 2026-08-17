// Server-side travel-leg validation — the OTHER half of the project's
// "validate what crosses the wire" posture (the browser half lives in
// `clientPayloads.test.ts`). A leg arrives here from a client, is stored,
// and comes back out to be rendered and drawn on a map; the ride detail on
// it is now four more facts, so it is four more things to check.
// Run with: npx tsx app/api/_shared/schemas.test.ts
import assert from "node:assert";
import {
  parseTravelLegs,
  validateTravelIdentityTopology,
} from "./schemas";

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

const rideIdentity = {
  rideId: "ride:fixture_1.0",
  sourceStepIndex: 3,
  paletteSlot: 23,
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
    "the complete leg/ride identity bundle survives server validation unchanged",
    () => {
      const ride = { ...rideWithTimes, ...rideIdentity, paletteSlot: null };
      const leg = parseTravelLegs([
        {
          ...legWith(ride)[0],
          legId: "leg:fixture_1.0",
          pathSegments: [
            { mode: "walk", encodedPolyline: "enc_walk", color: null },
            {
              mode: "transit",
              encodedPolyline: "enc_ride",
              color: "#d71920",
              ...rideIdentity,
              paletteSlot: null,
            },
          ],
        },
      ])[0];

      assert.strictEqual(leg.legId, "leg:fixture_1.0");
      assert.deepStrictEqual(
        {
          rideId: leg.transit?.rideId,
          sourceStepIndex: leg.transit?.sourceStepIndex,
          paletteSlot: leg.transit?.paletteSlot,
        },
        { ...rideIdentity, paletteSlot: null }
      );
      assert.deepStrictEqual(leg.pathSegments?.[1], {
        mode: "transit",
        encodedPolyline: "enc_ride",
        color: "#d71920",
        ...rideIdentity,
        paletteSlot: null,
      });
    },
  ],
  [
    "ride facts reject partial or malformed identity bundles while legacy all-absent facts remain valid",
    () => {
      assert.strictEqual(parseTravelLegs(legWith(transitSummary)).length, 1);
      const invalidBundles = [
        { rideId: "ride:partial" },
        { ...rideIdentity, rideId: "-bad-prefix" },
        { ...rideIdentity, rideId: "x".repeat(129) },
        { ...rideIdentity, sourceStepIndex: -1 },
        { ...rideIdentity, sourceStepIndex: 1.5 },
        { ...rideIdentity, sourceStepIndex: Number.MAX_SAFE_INTEGER + 1 },
        { ...rideIdentity, paletteSlot: -1 },
        { ...rideIdentity, paletteSlot: 24 },
        { ...rideIdentity, paletteSlot: 1.5 },
        { ...rideIdentity, paletteSlot: undefined },
      ];
      for (const bundle of invalidBundles) {
        assert.throws(() =>
          parseTravelLegs(legWith({ ...transitSummary, ...bundle }))
        );
      }
    },
  ],
  [
    "legId is optional for legacy legs but a present value must use the travel-id contract",
    () => {
      const identifiedRide = { ...transitSummary, ...rideIdentity };
      assert.strictEqual(
        parseTravelLegs([{ ...legWith(identifiedRide)[0], legId: "leg:A_b-1.2" }])[0]
          .legId,
        "leg:A_b-1.2"
      );
      assert.throws(() => parseTravelLegs(legWith(identifiedRide)));
      assert.throws(() =>
        parseTravelLegs([
          { ...legWith(transitSummary)[0], legId: "leg:partial-upgrade" },
        ])
      );
      for (const legId of ["", "-bad", "bad id", "x".repeat(129), null, 7]) {
        assert.throws(() =>
          parseTravelLegs([{ ...legWith(transitSummary)[0], legId }])
        );
      }
      assert.strictEqual(parseTravelLegs(legWith(transitSummary))[0].legId, undefined);
    },
  ],
  [
    "path identity is preserved only for complete transit bundles and is forbidden on walks",
    () => {
      const identifiedRide = { ...transitSummary, ...rideIdentity };
      const leg = parseTravelLegs([
        {
          ...legWith(identifiedRide)[0],
          legId: "leg:path-contract",
          pathSegments: [
            { mode: "walk", encodedPolyline: "walk_ok", color: null },
            { mode: "transit", encodedPolyline: "ride_legacy", color: null },
            {
              mode: "transit",
              encodedPolyline: "ride_identified",
              color: "#d71920",
              ...rideIdentity,
            },
            { mode: "transit", encodedPolyline: "ride_partial", rideId: "ride:partial" },
            {
              mode: "transit",
              encodedPolyline: "ride_bad_slot",
              ...rideIdentity,
              paletteSlot: 24,
            },
            { mode: "walk", encodedPolyline: "walk_with_ride", ...rideIdentity },
          ],
        },
      ])[0];

      assert.deepStrictEqual(leg.pathSegments, [
        { mode: "walk", encodedPolyline: "walk_ok", color: null },
        {
          mode: "transit",
          encodedPolyline: "ride_identified",
          color: "#d71920",
          ...rideIdentity,
        },
      ]);
      const legacy = parseTravelLegs([
        {
          ...legWith(transitSummary)[0],
          pathSegments: [
            { mode: "transit", encodedPolyline: "ride_legacy", color: null },
          ],
        },
      ])[0];
      assert.deepStrictEqual(legacy.pathSegments, [
        { mode: "transit", encodedPolyline: "ride_legacy", color: null },
      ]);
      const sanitizedPartialUpgrade = parseTravelLegs([
        {
          ...legWith(transitSummary)[0],
          pathSegments: [
            {
              mode: "transit",
              encodedPolyline: "identified_without_leg",
              ...rideIdentity,
            },
          ],
        },
      ])[0];
      assert.strictEqual(sanitizedPartialUpgrade.pathSegments, undefined);
    },
  ],
  [
    "facts reject relational identity conflicts while conflicting geometry is sanitized away",
    () => {
      const ride = { ...transitSummary, ...rideIdentity };
      assert.throws(() =>
        parseTravelLegs([
          {
            ...legWith(ride)[0],
            legId: "leg:relational-a",
            transitSegments: [{ ...ride, paletteSlot: 22 }],
          },
        ])
      );
      assert.throws(() =>
        parseTravelLegs([
          {
            ...legWith(ride)[0],
            legId: "leg:relational-b",
            transitSegments: [
              {
                ...ride,
                rideId: "ride:other",
                sourceStepIndex: rideIdentity.sourceStepIndex,
              },
            ],
          },
        ])
      );
      assert.throws(() =>
        parseTravelLegs([
          {
            ...legWith(ride)[0],
            legId: "leg:relational-c",
            transitSegments: [ride, { ...ride }],
          },
        ])
      );
      const otherFirst = {
        ...ride,
        rideId: "ride:other-first",
        sourceStepIndex: 8,
        paletteSlot: 8,
      };
      assert.throws(() =>
        parseTravelLegs([
          {
            ...legWith(ride)[0],
            legId: "leg:relational-d",
            transitSegments: [otherFirst, ride],
          },
        ])
      );
      assert.throws(() =>
        parseTravelLegs([
          {
            ...legWith(ride)[0],
            legId: "leg:compatibility-only",
            transitSegments: undefined,
          },
        ])
      );
      assert.throws(() =>
        parseTravelLegs([
          {
            ...legWith(ride)[0],
            legId: "leg:segments-only",
            transit: undefined,
          },
        ])
      );

      const sanitized = parseTravelLegs([
        {
          ...legWith(ride)[0],
          legId: "leg:relational-path",
          pathSegments: [
            {
              mode: "transit",
              encodedPolyline: "conflicting_slot",
              ...rideIdentity,
              paletteSlot: 22,
            },
          ],
        },
      ])[0];
      assert.strictEqual(sanitized.pathSegments, undefined);
      assert.strictEqual(sanitized.transit?.paletteSlot, 23);
    },
  ],
  [
    "duplicate ride, leg, or non-null palette identities are rejected across a topology",
    () => {
      const firstRide = { ...transitSummary, ...rideIdentity, paletteSlot: 0 };
      const secondRide = {
        ...transitSummary,
        ...rideIdentity,
        rideId: "ride:second",
        paletteSlot: 0,
      };
      const firstLeg = {
        ...legWith(firstRide)[0],
        legId: "leg:first",
        fromIndex: -1,
      };
      const secondLeg = {
        ...legWith(secondRide)[0],
        legId: "leg:second",
        fromIndex: 0,
      };
      assert.throws(() => parseTravelLegs([firstLeg, secondLeg]));
      assert.throws(() =>
        parseTravelLegs([
          firstLeg,
          { ...secondLeg, legId: "leg:first", transit: transitSummary, transitSegments: [transitSummary] },
        ])
      );

      const separatelyParsed = [
        parseTravelLegs([firstLeg], "homeLeg")[0],
        parseTravelLegs([secondLeg], "legs")[0],
      ];
      assert.throws(() =>
        validateTravelIdentityTopology(separatelyParsed, "homeLeg/legs")
      );
    },
  ],
  [
    "a path-only cross-leg slot collision is dropped without rejecting the plan",
    () => {
      const factRide = { ...transitSummary, ...rideIdentity, paletteSlot: 0 };
      const legs = parseTravelLegs([
        {
          ...legWith(factRide)[0],
          legId: "leg:fact",
          fromIndex: -1,
        },
        {
          fromIndex: 0,
          mode: "transit",
          rawMinutes: 8,
          marginMinutes: 5,
          totalMinutes: 13,
          distanceMeters: 900,
          encodedPolyline: "whole",
          legId: "leg:path",
          pathSegments: [
            {
              mode: "transit",
              encodedPolyline: "path_only",
              rideId: "ride:path-only",
              sourceStepIndex: 0,
              paletteSlot: 0,
            },
          ],
        },
      ]);
      assert.strictEqual(legs[1].pathSegments, undefined);
      assert.strictEqual(legs.length, 2);
    },
  ],
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
    "PER-STEP GEOMETRY survives the wire in order, and a leg without it still validates",
    () => {
      const drawn = parseTravelLegs([
        {
          ...legWith(rideWithTimes)[0],
          pathSegments: [
            { mode: "walk", encodedPolyline: "enc_walk", color: null },
            { mode: "transit", encodedPolyline: "enc_ride", color: "#d71920" },
          ],
        },
      ])[0];
      assert.deepStrictEqual(drawn.pathSegments, [
        { mode: "walk", encodedPolyline: "enc_walk", color: null },
        { mode: "transit", encodedPolyline: "enc_ride", color: "#d71920" },
      ]);
      // BACKWARD COMPAT: every plan stored before geometry was read, plus
      // the walk legs and the estimate fallback, have no such key
      assert.strictEqual(parseTravelLegs(legWith(rideWithTimes))[0].pathSegments, undefined);
    },
  ],
  [
    "a MALFORMED segment is dropped and the leg survives — geometry is a decoration, not the plan",
    () => {
      const leg = parseTravelLegs([
        {
          ...legWith(transitSummary)[0],
          pathSegments: [
            { mode: "drive", encodedPolyline: "enc_car" }, // not a mode we draw
            { mode: "walk", encodedPolyline: "" }, // empty is not geometry
            { mode: "walk", encodedPolyline: "x".repeat(5_000) }, // past the cap
            { mode: "transit", encodedPolyline: 42 }, // not a string
            { mode: "walk", encodedPolyline: "enc_ok" },
          ],
        },
      ])[0];
      assert.deepStrictEqual(
        leg.pathSegments,
        [{ mode: "walk", encodedPolyline: "enc_ok" }],
        "only the well-formed segment is stored"
      );
      // and the leg itself is still here, with its ride intact
      assert.strictEqual(leg.totalMinutes, 27);
      assert.strictEqual(leg.transit?.lineName, "501 Queen");
    },
  ],
  [
    "when NOTHING survives the key is dropped, so a bad array can never be stored",
    () => {
      const leg = parseTravelLegs([
        {
          ...legWith(transitSummary)[0],
          pathSegments: [{ mode: "walk" }, "enc_walk", null],
        },
      ])[0];
      assert.strictEqual(leg.pathSegments, undefined);
      assert.ok(!("pathSegments" in leg));
    },
  ],
  [
    "the FIELD's own shape is still refused: not an array, or more steps than a journey has",
    () => {
      assert.throws(() =>
        parseTravelLegs([{ ...legWith(transitSummary)[0], pathSegments: "enc" }])
      );
      assert.throws(() =>
        parseTravelLegs([
          {
            ...legWith(transitSummary)[0],
            pathSegments: Array.from({ length: 129 }, () => ({
              mode: "walk",
              encodedPolyline: "enc",
            })),
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
