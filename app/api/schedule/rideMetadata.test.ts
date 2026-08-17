// Focused contract tests for app-owned transit ride identity + palette slots.
// Run with: npx tsx app/api/schedule/rideMetadata.test.ts
import assert from "node:assert";
import {
  assignTransitPaletteSlots,
  buildLeg,
  extractTravelStepRecords,
  type ComputeRoutesResponse,
  type PathSegment,
  type TransitSummary,
  type TravelIdentityFactory,
  type TravelLeg,
  TRANSIT_PALETTE_CAPACITY,
} from "./travel";

function identitySequence(namespace = "test"): TravelIdentityFactory {
  let next = 0;
  return (kind) => `${namespace}-${kind}-${next++}`;
}

function rideFacts(
  name: string,
  color: string | null,
  textColor = color ? "#ffffff" : undefined
): NonNullable<
  NonNullable<
    NonNullable<
      NonNullable<ComputeRoutesResponse["routes"]>[number]["legs"]
    >[number]["steps"]
  >[number]["transitDetails"]
> {
  return {
    headsign: `${name} terminus`,
    stopCount: 3,
    transitLine: {
      name,
      nameShort: name,
      color: color ?? undefined,
      textColor,
      vehicle: { type: "BUS" },
    },
  };
}

function asymmetricRoute(
  firstColor = "#ed1c24",
  lastColor = "#009247",
  firstTextColor = "#ffffff",
  lastTextColor = "#ffffff"
): ComputeRoutesResponse {
  return {
    routes: [
      {
        duration: "1800s",
        distanceMeters: 7200,
        polyline: { encodedPolyline: "whole" },
        legs: [
          {
            steps: [
              { travelMode: "WALK", polyline: { encodedPolyline: "walk-a" } },
              {
                travelMode: "TRANSIT",
                polyline: { encodedPolyline: "ride-both-a" },
                transitDetails: rideFacts("A", firstColor, firstTextColor),
              },
              {
                travelMode: "TRANSIT",
                // Facts survive; rejected geometry must not collapse the
                // next ride's source identity into this occurrence.
                polyline: { encodedPolyline: "" },
                transitDetails: rideFacts("B", firstColor, firstTextColor),
              },
              {
                travelMode: "TRANSIT",
                polyline: { encodedPolyline: "ride-geometry-only" },
                // Geometry survives with no facts record.
              },
              { travelMode: "WALK" },
              {
                travelMode: "TRANSIT",
                polyline: { encodedPolyline: "ride-both-late" },
                transitDetails: rideFacts("C", lastColor, lastTextColor),
              },
            ],
          },
        ],
      },
    ],
  };
}

function summary(
  rideId: string,
  sourceStepIndex: number,
  paletteSlot: number | null
): TransitSummary {
  return {
    rideId,
    sourceStepIndex,
    paletteSlot,
    lineName: rideId,
    shortName: rideId,
    color: "#ed1c24",
    textColor: "#ffffff",
    vehicle: "BUS",
    headsign: "Downtown",
    stopCount: 2,
    departStop: "A",
    arriveStop: "B",
  };
}

function identifiedLeg(
  legId: string,
  rides: Array<{ id: string; slot: number | null }>,
  fromIndex = 0
): TravelLeg {
  const transitSegments = rides.map((ride, sourceStepIndex) =>
    summary(ride.id, sourceStepIndex, ride.slot)
  );
  const pathSegments: PathSegment[] = rides.map((ride, sourceStepIndex) => ({
    mode: "transit",
    encodedPolyline: `enc-${ride.id}`,
    color: "#ed1c24",
    rideId: ride.id,
    sourceStepIndex,
    paletteSlot: ride.slot,
  }));
  return {
    legId,
    fromIndex,
    mode: "transit",
    rawMinutes: 10,
    marginMinutes: 5,
    totalMinutes: 15,
    distanceMeters: 1000,
    encodedPolyline: "whole",
    transit: { ...transitSegments[0] },
    transitSegments,
    pathSegments,
  };
}

function ridePaths(leg: TravelLeg) {
  return (leg.pathSegments ?? []).filter(
    (segment): segment is Extract<PathSegment, { mode: "transit" }> =>
      segment.mode === "transit"
  );
}

const cases: Array<[string, () => void]> = [
  [
    "one source transit step gives geometry and facts the exact same ride identity and slot",
    () => {
      const leg = buildLeg(0, asymmetricRoute(), null, identitySequence("shared"));
      assignTransitPaletteSlots([leg]);
      const facts = leg.transitSegments![0];
      const path = ridePaths(leg)[0];
      assert.strictEqual(facts.sourceStepIndex, 1);
      assert.strictEqual(path.sourceStepIndex, 1);
      assert.strictEqual(path.rideId, facts.rideId);
      assert.strictEqual(path.paletteSlot, facts.paletteSlot);
      assert.strictEqual(facts.paletteSlot, 0);
      assert.strictEqual(leg.transit?.rideId, facts.rideId);
      assert.strictEqual(leg.transit?.paletteSlot, facts.paletteSlot);
    },
  ],
  [
    "the exported step extractor returns geometry and facts from one identity traversal",
    () => {
      const records = extractTravelStepRecords(
        asymmetricRoute().routes![0],
        identitySequence("extract")
      );
      const facts = records.transit.find((ride) => ride.sourceStepIndex === 5)!;
      const path = records.paths.find(
        (segment) =>
          segment.mode === "transit" && segment.sourceStepIndex === 5
      );
      assert.ok(path?.mode === "transit");
      assert.strictEqual(path.rideId, facts.rideId);
      assert.strictEqual(path.sourceStepIndex, facts.sourceStepIndex);
    },
  ],
  [
    "asymmetric filters preserve one-sided occurrences and never shift a later ride",
    () => {
      const leg = buildLeg(0, asymmetricRoute(), null, identitySequence("gap"));
      assignTransitPaletteSlots([leg]);
      const facts = leg.transitSegments!;
      const paths = ridePaths(leg);
      assert.deepStrictEqual(
        facts.map((ride) => [ride.lineName, ride.sourceStepIndex, ride.paletteSlot]),
        [
          ["A", 1, 0],
          ["B", 2, 1], // facts-only: no stolen later geometry
          ["C", 5, 3],
        ]
      );
      assert.deepStrictEqual(
        paths.map((path) => [path.encodedPolyline, path.sourceStepIndex, path.paletteSlot]),
        [
          ["ride-both-a", 1, 0],
          ["ride-geometry-only", 3, 2], // geometry-only keeps its occurrence
          ["ride-both-late", 5, 3],
        ]
      );
      const lateFacts = facts.find((ride) => ride.sourceStepIndex === 5)!;
      const latePath = paths.find((path) => path.sourceStepIndex === 5)!;
      assert.strictEqual(latePath.rideId, lateFacts.rideId);
      assert.strictEqual(latePath.paletteSlot, lateFacts.paletteSlot);
    },
  ],
  [
    "two rides in one leg have distinct IDs and slots while walk steps have neither",
    () => {
      const leg = buildLeg(0, asymmetricRoute(), null, identitySequence("inside"));
      assignTransitPaletteSlots([leg]);
      const rideIds = [
        ...leg.transitSegments!.map((ride) => ride.rideId),
        ...ridePaths(leg).map((path) => path.rideId),
      ];
      assert.strictEqual(new Set(rideIds).size, 4);
      assert.deepStrictEqual(
        Array.from(new Set([
          ...leg.transitSegments!.map((ride) => ride.paletteSlot),
          ...ridePaths(leg).map((path) => path.paletteSlot),
        ])).sort((a, b) => Number(a) - Number(b)),
        [0, 1, 2, 3]
      );
      const walk = leg.pathSegments![0] as PathSegment & Record<string, unknown>;
      assert.strictEqual(walk.mode, "walk");
      assert.ok(!("rideId" in walk));
      assert.ok(!("sourceStepIndex" in walk));
      assert.ok(!("paletteSlot" in walk));
    },
  ],
  [
    "home then inter-stop/provider order controls slots and every leg/ride ID is distinct",
    () => {
      const ids = identitySequence("day");
      const home = buildLeg(-1, asymmetricRoute(), null, ids);
      const first = buildLeg(0, asymmetricRoute(), null, ids);
      const second = buildLeg(1, asymmetricRoute(), null, ids);
      assignTransitPaletteSlots([home, first, second]);
      assert.strictEqual(new Set([home.legId, first.legId, second.legId]).size, 3);
      const all = [home, first, second].flatMap((leg) => [
        ...leg.transitSegments!,
        ...ridePaths(leg).filter(
          (path) => !leg.transitSegments!.some((ride) => ride.rideId === path.rideId)
        ),
      ]).sort((a, b) =>
        [home, first, second].findIndex((leg) =>
          leg.transitSegments?.some((ride) => ride.rideId === a.rideId) ||
          ridePaths(leg).some((path) => path.rideId === a.rideId)
        ) -
        [home, first, second].findIndex((leg) =>
          leg.transitSegments?.some((ride) => ride.rideId === b.rideId) ||
          ridePaths(leg).some((path) => path.rideId === b.rideId)
        ) ||
        a.sourceStepIndex! - b.sourceStepIndex!
      );
      assert.deepStrictEqual(all.map((ride) => ride.paletteSlot), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      assert.strictEqual(new Set(all.map((ride) => ride.rideId)).size, 12);
    },
  ],
  [
    "provider colors and text colors cannot influence deterministic identity or allocation",
    () => {
      const red = buildLeg(
        0,
        asymmetricRoute("#ed1c24", "#009247", "#ffffff", "#111111"),
        null,
        identitySequence("color")
      );
      const blue = buildLeg(
        0,
        asymmetricRoute("#0000ff", "#ff00ff", "#eeeeee", "#222222"),
        null,
        identitySequence("color")
      );
      assignTransitPaletteSlots([red]);
      assignTransitPaletteSlots([blue]);
      assert.deepStrictEqual(
        red.transitSegments!.map((ride) => [ride.rideId, ride.sourceStepIndex, ride.paletteSlot]),
        blue.transitSegments!.map((ride) => [ride.rideId, ride.sourceStepIndex, ride.paletteSlot])
      );
      assert.notDeepStrictEqual(
        red.transitSegments!.map((ride) => ride.color),
        blue.transitSegments!.map((ride) => ride.color)
      );
      assert.notDeepStrictEqual(
        red.transitSegments!.map((ride) => ride.textColor),
        blue.transitSegments!.map((ride) => ride.textColor)
      );
    },
  ],
  [
    "retained slots are reserved before earlier new rides take the first unused slots",
    () => {
      const earlierNew = identifiedLeg("leg-new", [
        { id: "new-a", slot: null },
        { id: "new-b", slot: null },
      ]);
      const laterRetained = identifiedLeg("leg-old", [
        { id: "old-a", slot: 1 },
        { id: "old-b", slot: 3 },
      ], 1);
      assignTransitPaletteSlots([earlierNew, laterRetained]);
      assert.deepStrictEqual(earlierNew.transitSegments!.map((ride) => ride.paletteSlot), [0, 2]);
      assert.deepStrictEqual(laterRetained.transitSegments!.map((ride) => ride.paletteSlot), [1, 3]);
      assert.deepStrictEqual(ridePaths(laterRetained).map((ride) => ride.paletteSlot), [1, 3]);
    },
  ],
  [
    "exactly 24 rides receive unique slots and ride 25 remains valid explicit overflow",
    () => {
      const leg = identifiedLeg(
        "leg-overflow",
        Array.from({ length: TRANSIT_PALETTE_CAPACITY + 1 }, (_, index) => ({
          id: `ride-${index}`,
          slot: null,
        }))
      );
      assignTransitPaletteSlots([leg]);
      assert.deepStrictEqual(
        leg.transitSegments!.slice(0, TRANSIT_PALETTE_CAPACITY).map((ride) => ride.paletteSlot),
        Array.from({ length: TRANSIT_PALETTE_CAPACITY }, (_, index) => index)
      );
      assert.strictEqual(leg.transitSegments![24].paletteSlot, null);
      assert.strictEqual(ridePaths(leg)[24].paletteSlot, null);
      assert.strictEqual(leg.transitSegments!.length, 25, "overflow never rejects the ride");
    },
  ],
  [
    "legacy records remain byte-identical and are never paired by filtered position",
    () => {
      const legacy: TravelLeg = {
        fromIndex: 0,
        mode: "transit",
        rawMinutes: 10,
        marginMinutes: 5,
        totalMinutes: 15,
        distanceMeters: 1000,
        encodedPolyline: "whole",
        transitSegments: [
          { ...summary("discarded", 0, null), rideId: undefined, sourceStepIndex: undefined, paletteSlot: undefined },
        ],
        pathSegments: [{ mode: "transit", encodedPolyline: "legacy", color: "#ed1c24" }],
      };
      const before = JSON.stringify(legacy);
      assignTransitPaletteSlots([legacy]);
      assert.strictEqual(JSON.stringify(legacy), before);
    },
  ],
  [
    "computed transit, walk, and unknown legs all receive opaque leg identities",
    () => {
      const ids = identitySequence("mode");
      const transit = buildLeg(0, asymmetricRoute(), null, ids);
      const walk = buildLeg(1, null, {
        routes: [{ duration: "300s", distanceMeters: 300, polyline: { encodedPolyline: "walk" } }],
      }, ids);
      const unknown = buildLeg(2, null, null, ids);
      for (const leg of [transit, walk, unknown]) {
        assert.match(leg.legId!, /^mode-leg-/);
      }
      assert.strictEqual(new Set([transit.legId, walk.legId, unknown.legId]).size, 3);
    },
  ],
  [
    "valid metadata survives JSON serialization without becoming user facts",
    () => {
      const leg = buildLeg(0, asymmetricRoute(), null, identitySequence("json"));
      assignTransitPaletteSlots([leg]);
      const restored = JSON.parse(JSON.stringify(leg)) as TravelLeg;
      assert.deepStrictEqual(restored, leg);
      assert.strictEqual(restored.rawMinutes, 30);
      assert.strictEqual(restored.totalMinutes, 35);
      assert.strictEqual(restored.distanceMeters, 7200);
      assert.strictEqual(restored.encodedPolyline, "whole");
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
    console.log(`      ${error instanceof Error ? error.stack ?? error.message : error}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
