// Home origin unit tests — the constant and the leg splitting that
// turns getTravelLegs([HOME, ...venues]) output into leg 0 + re-indexed
// inter-stop legs.
// Run with: npx tsx app/api/schedule/home.test.ts
import assert from "node:assert";
import { HOME, HOME_LEG_INDEX, splitHomeLeg } from "./home";
import { TravelLeg } from "./travel";

const leg = (fromIndex: number, total = 10): TravelLeg => ({
  fromIndex,
  mode: "walk",
  rawMinutes: total,
  marginMinutes: 0,
  totalMinutes: total,
  distanceMeters: 500,
  encodedPolyline: null,
});

const cases: Array<[string, () => void]> = [
  [
    "HOME is Chestnut Residence (89 Chestnut St)",
    () => {
      assert.strictEqual(HOME.label, "Home · Chestnut Residence");
      assert.strictEqual(HOME.location.latitude, 43.6547);
      assert.strictEqual(HOME.location.longitude, -79.3862);
    },
  ],
  [
    "split: first leg becomes the home leg (sentinel index), rest re-index to 0-based pairs",
    () => {
      const { homeLeg, interLegs } = splitHomeLeg([
        leg(0, 32), // home → stop 1
        leg(1, 10), // stop 1 → stop 2
        leg(2, 7), // stop 2 → stop 3
      ]);
      assert.strictEqual(homeLeg?.fromIndex, HOME_LEG_INDEX);
      assert.strictEqual(homeLeg?.totalMinutes, 32);
      assert.deepStrictEqual(
        interLegs.map((l) => [l.fromIndex, l.totalMinutes]),
        [
          [0, 10],
          [1, 7],
        ]
      );
    },
  ],
  [
    "split: single leg (home → only stop) → home leg, no inter legs",
    () => {
      const { homeLeg, interLegs } = splitHomeLeg([leg(0, 25)]);
      assert.strictEqual(homeLeg?.fromIndex, HOME_LEG_INDEX);
      assert.strictEqual(homeLeg?.totalMinutes, 25);
      assert.deepStrictEqual(interLegs, []);
    },
  ],
  [
    "split preserves opaque leg and ride palette metadata while changing only fromIndex",
    () => {
      const identified: TravelLeg = {
        ...leg(0, 25),
        legId: "leg-home-1",
        mode: "transit",
        transit: {
          rideId: "ride-home-1",
          sourceStepIndex: 2,
          paletteSlot: 0,
          lineName: "505 Dundas",
          shortName: "505",
          color: "#DA291C",
          textColor: "#FFFFFF",
          vehicle: "TRAM",
          headsign: "Broadview",
          stopCount: 4,
          departStop: "A",
          arriveStop: "B",
        },
        pathSegments: [
          {
            mode: "transit",
            encodedPolyline: "enc-home",
            color: "#DA291C",
            rideId: "ride-home-1",
            sourceStepIndex: 2,
            paletteSlot: 0,
          },
        ],
      };
      identified.transitSegments = [identified.transit!];
      const { homeLeg } = splitHomeLeg([identified]);
      assert.strictEqual(homeLeg?.fromIndex, HOME_LEG_INDEX);
      assert.strictEqual(homeLeg?.legId, "leg-home-1");
      assert.strictEqual(homeLeg?.transit?.rideId, "ride-home-1");
      assert.strictEqual(homeLeg?.transit?.paletteSlot, 0);
      const path = homeLeg?.pathSegments?.[0];
      assert.strictEqual(path?.mode, "transit");
      assert.strictEqual(path?.mode === "transit" ? path.paletteSlot : undefined, 0);
    },
  ],
  [
    "split: no legs → no home leg (nothing to prepend)",
    () => {
      assert.deepStrictEqual(splitHomeLeg([]), { homeLeg: null, interLegs: [] });
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
