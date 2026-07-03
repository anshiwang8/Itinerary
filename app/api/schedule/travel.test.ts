// Unit tests for travel legs + schedule integration.
// Run with: npx tsx app/api/schedule/travel.test.ts
import assert from "node:assert";
import {
  extractConsecutiveLegs,
  MatrixElement,
  SHORT_LEG_WALK_METERS,
  TRANSIT_MARGIN_MIN,
} from "./travel";
import { buildSchedule } from "./schedule";

const NOW = new Date(2026, 6, 3, 13, 20, 0); // Fri 2026-07-03 13:20 EDT

// helper: matrix element
function el(
  o: number,
  d: number,
  seconds: number | null,
  condition = "ROUTE_EXISTS"
): MatrixElement {
  return {
    originIndex: o,
    destinationIndex: d,
    ...(seconds !== null ? { duration: `${seconds}s` } : {}),
    distanceMeters: seconds !== null ? seconds * 10 : undefined,
    condition,
  };
}

// full 3×3 transit matrix (only consecutive pairs matter; extras prove
// the extractor ignores non-consecutive elements)
const TRANSIT_3 = [
  el(0, 1, 1200), // 20 min
  el(1, 2, 480), // 8 min
  el(0, 2, 1800),
  el(1, 0, 1260),
  el(2, 1, 500),
];

const cases: Array<[string, () => void]> = [
  [
    "leg extraction: consecutive pairs only, transit margin applied",
    () => {
      const legs = extractConsecutiveLegs(TRANSIT_3, null, 3);
      assert.strictEqual(legs.length, 2);
      assert.deepStrictEqual(legs[0], {
        fromIndex: 0,
        mode: "transit",
        rawMinutes: 20,
        marginMinutes: TRANSIT_MARGIN_MIN,
        totalMinutes: 20 + TRANSIT_MARGIN_MIN,
        distanceMeters: 12000,
      });
      assert.strictEqual(legs[1].rawMinutes, 8);
      assert.strictEqual(legs[1].totalMinutes, 8 + TRANSIT_MARGIN_MIN);
    },
  ],
  [
    "transit no-route → walk fallback, NO margin on walking legs",
    () => {
      const transit = [
        el(0, 1, null, "ROUTE_NOT_FOUND"),
        el(1, 2, 600),
      ];
      const walk = [el(0, 1, 540)]; // 9 min walk
      const legs = extractConsecutiveLegs(transit, walk, 3);
      assert.deepStrictEqual(legs[0], {
        fromIndex: 0,
        mode: "walk",
        rawMinutes: 9,
        marginMinutes: 0,
        totalMinutes: 9,
        distanceMeters: 5400,
      });
      // second leg still transit with margin
      assert.strictEqual(legs[1].mode, "transit");
      assert.strictEqual(legs[1].totalMinutes, 10 + TRANSIT_MARGIN_MIN);
    },
  ],
  [
    "neither transit nor walk usable → mode unknown, 0 minutes",
    () => {
      const transit = [el(0, 1, null, "ROUTE_NOT_FOUND")];
      const walk = [el(0, 1, null, "ROUTE_NOT_FOUND")];
      const legs = extractConsecutiveLegs(transit, walk, 2);
      assert.deepStrictEqual(legs[0], {
        fromIndex: 0,
        mode: "unknown",
        rawMinutes: 0,
        marginMinutes: 0,
        totalMinutes: 0,
        distanceMeters: null,
      });
    },
  ],
  [
    "fractional seconds round UP to whole minutes",
    () => {
      const legs = extractConsecutiveLegs([el(0, 1, 61)], null, 2);
      assert.strictEqual(legs[0].rawMinutes, 2);
    },
  ],
  [
    "193m scenario: short transit hop relabeled walk, margin skipped",
    () => {
      // real case from the live run: TRANSIT returned a 3-min route over
      // 193m (Google walks short segments inside transit routing)
      const transit: MatrixElement[] = [
        { originIndex: 0, destinationIndex: 1, duration: "180s", distanceMeters: 193, condition: "ROUTE_EXISTS" },
      ];
      const legs = extractConsecutiveLegs(transit, null, 2);
      assert.deepStrictEqual(legs[0], {
        fromIndex: 0,
        mode: "walk",
        rawMinutes: 3,
        marginMinutes: 0,
        totalMinutes: 3,
        distanceMeters: 193,
      });
      assert.ok(193 < SHORT_LEG_WALK_METERS);
    },
  ],
  [
    "transit no faster than walking the same leg → walk label, no margin",
    () => {
      // 8 min transit over 900m (past the distance threshold), but the
      // walk matrix says 10 min → transit isn't buying anything, walk it
      const transit: MatrixElement[] = [
        { originIndex: 0, destinationIndex: 1, duration: "480s", distanceMeters: 900, condition: "ROUTE_EXISTS" },
      ];
      const walk: MatrixElement[] = [
        { originIndex: 0, destinationIndex: 1, duration: "600s", distanceMeters: 800, condition: "ROUTE_EXISTS" },
      ];
      const legs = extractConsecutiveLegs(transit, walk, 2);
      assert.strictEqual(legs[0].mode, "walk");
      assert.strictEqual(legs[0].marginMinutes, 0);
      assert.strictEqual(legs[0].totalMinutes, 8);
      // …but genuinely faster transit keeps the label and margin
      const fasterWalk: MatrixElement[] = [
        { originIndex: 0, destinationIndex: 1, duration: "420s", distanceMeters: 800, condition: "ROUTE_EXISTS" },
      ];
      const legs2 = extractConsecutiveLegs(transit, fasterWalk, 2);
      assert.strictEqual(legs2[0].mode, "transit");
      assert.strictEqual(legs2[0].totalMinutes, 8 + TRANSIT_MARGIN_MIN);
    },
  ],
  [
    "schedule chain: travel inserted between stops, times sum correctly",
    () => {
      const legs = extractConsecutiveLegs(TRANSIT_3, null, 3);
      const { stops } = buildSchedule(
        [
          { category: "ramen", id: "r1", name: "Ramen" },   // 105 min
          { category: "cocktails", id: "b1", name: "Bar" }, // 70 min
          { category: "gelato", id: "d1", name: "Gelato" }, // 40 min
        ],
        "evening", // 19:00
        NOW,
        legs
      );
      // stop 1: 19:00–20:45, then 25 min transit (20+5)
      assert.strictEqual(stops[0].start_time, "2026-07-03T19:00:00-04:00");
      assert.strictEqual(stops[0].end_time, "2026-07-03T20:45:00-04:00");
      assert.strictEqual(stops[0].travelMinutesToNext, 25);
      assert.strictEqual(stops[0].travelToNext?.mode, "transit");
      // stop 2: 21:10–22:20, then 13 min transit (8+5)
      assert.strictEqual(stops[1].start_time, "2026-07-03T21:10:00-04:00");
      assert.strictEqual(stops[1].end_time, "2026-07-03T22:20:00-04:00");
      assert.strictEqual(stops[1].travelMinutesToNext, 13);
      // stop 3: 22:33–23:13, no trailing leg
      assert.strictEqual(stops[2].start_time, "2026-07-03T22:33:00-04:00");
      assert.strictEqual(stops[2].end_time, "2026-07-03T23:13:00-04:00");
      assert.strictEqual(stops[2].travelMinutesToNext, undefined);
      assert.strictEqual(stops[2].travelToNext, undefined);
    },
  ],
  [
    "no legs passed → behaves like the old 0-placeholder schedule",
    () => {
      const { stops } = buildSchedule(
        [
          { category: "coffee shop", id: "c1" },
          { category: "bar", id: "b1" },
        ],
        "morning",
        NOW
      );
      assert.strictEqual(stops[0].end_time, stops[1].start_time);
      assert.strictEqual(stops[0].travelMinutesToNext, 0);
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
