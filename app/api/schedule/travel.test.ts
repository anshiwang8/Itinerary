// Unit tests for travel legs (computeRoutes) + schedule integration.
// Run with: npx tsx app/api/schedule/travel.test.ts
import assert from "node:assert";
import {
  buildLeg,
  ComputeRoutesResponse,
  MAX_WALK_LABEL_MIN,
  SHORT_LEG_WALK_METERS,
  TRANSIT_MARGIN_MIN,
} from "./travel";
import { buildSchedule } from "./schedule";

const NOW = new Date(2026, 6, 3, 13, 20, 0); // Fri 2026-07-03 13:20 EDT

// helper: computeRoutes response mock
function mkRoute(
  seconds: number,
  meters: number,
  opts: { polyline?: string; transitStep?: boolean } = {}
): ComputeRoutesResponse {
  return {
    routes: [
      {
        duration: `${seconds}s`,
        distanceMeters: meters,
        polyline: { encodedPolyline: opts.polyline ?? "enc_test" },
        ...(opts.transitStep
          ? {
              legs: [
                {
                  steps: [
                    { transitDetails: undefined }, // leading walk step
                    {
                      transitDetails: {
                        headsign: "East - Main Street Station",
                        stopCount: 4,
                        transitLine: { name: "Carlton", nameShort: "506" },
                        stopDetails: {
                          departureStop: { name: "Ossington Ave" },
                          arrivalStop: { name: "Yonge St" },
                        },
                      },
                    },
                  ],
                },
              ],
            }
          : {}),
      },
    ],
  };
}
const NO_ROUTE: ComputeRoutesResponse = {};

const cases: Array<[string, () => void]> = [
  [
    "transit leg: margin applied, polyline present",
    () => {
      const leg = buildLeg(0, mkRoute(1200, 12000, { polyline: "enc_t" }), null);
      assert.deepStrictEqual(leg, {
        fromIndex: 0,
        mode: "transit",
        rawMinutes: 20,
        marginMinutes: TRANSIT_MARGIN_MIN,
        totalMinutes: 20 + TRANSIT_MARGIN_MIN,
        distanceMeters: 12000,
        encodedPolyline: "enc_t",
      });
    },
  ],
  [
    "transit no-route → walk fallback, NO margin, walk polyline",
    () => {
      const leg = buildLeg(0, NO_ROUTE, mkRoute(540, 5400, { polyline: "enc_w" }));
      assert.deepStrictEqual(leg, {
        fromIndex: 0,
        mode: "walk",
        rawMinutes: 9,
        marginMinutes: 0,
        totalMinutes: 9,
        distanceMeters: 5400,
        encodedPolyline: "enc_w",
      });
    },
  ],
  [
    "neither transit nor walk usable → mode unknown, 0 minutes, null polyline",
    () => {
      const leg = buildLeg(0, NO_ROUTE, NO_ROUTE);
      assert.deepStrictEqual(leg, {
        fromIndex: 0,
        mode: "unknown",
        rawMinutes: 0,
        marginMinutes: 0,
        totalMinutes: 0,
        distanceMeters: null,
        encodedPolyline: null,
      });
    },
  ],
  [
    "fractional seconds round UP to whole minutes",
    () => {
      assert.strictEqual(buildLeg(0, mkRoute(61, 900), null).rawMinutes, 2);
    },
  ],
  [
    "193m scenario: short transit hop relabeled walk, margin skipped, keeps route data",
    () => {
      const leg = buildLeg(0, mkRoute(180, 193, { polyline: "enc_short" }), null);
      assert.deepStrictEqual(leg, {
        fromIndex: 0,
        mode: "walk",
        rawMinutes: 3,
        marginMinutes: 0,
        totalMinutes: 3,
        distanceMeters: 193,
        encodedPolyline: "enc_short",
      });
      assert.ok(193 < SHORT_LEG_WALK_METERS);
    },
  ],
  [
    "walk competitive incl. margin → walk label with the WALK route's own numbers",
    () => {
      // 8 min transit + 5 margin = 13 door-to-door; a 10-min walk wins
      const leg = buildLeg(0, mkRoute(480, 900), mkRoute(600, 800, { polyline: "enc_w" }));
      assert.strictEqual(leg.mode, "walk");
      assert.strictEqual(leg.marginMinutes, 0);
      assert.strictEqual(leg.totalMinutes, 10); // walk route's time, not transit's
      assert.strictEqual(leg.distanceMeters, 800);
      assert.strictEqual(leg.encodedPolyline, "enc_w");
      // a 7-min walk beats it even harder
      const leg2 = buildLeg(0, mkRoute(480, 900), mkRoute(420, 800));
      assert.strictEqual(leg2.mode, "walk");
      assert.strictEqual(leg2.totalMinutes, 7);
    },
  ],
  [
    "REGRESSION (75-min walk): a long walk never beats similar transit — the relabel is capped",
    () => {
      // the mentor's live shape: walk 75 min vs transit 72 min — the old
      // rule called 75 <= 72+5 "competitive" and presented an hour-plus
      // WALK. Beyond MAX_WALK_LABEL_MIN the leg must stay transit.
      const leg = buildLeg(0, mkRoute(72 * 60, 6100, { transitStep: true }), mkRoute(75 * 60, 5800));
      assert.strictEqual(leg.mode, "transit");
      assert.strictEqual(leg.totalMinutes, 72 + TRANSIT_MARGIN_MIN);
      assert.ok(75 > MAX_WALK_LABEL_MIN);
      // boundary: a walk AT the cap that beats transit still relabels
      const atCap = buildLeg(0, mkRoute(28 * 60, 2500), mkRoute(MAX_WALK_LABEL_MIN * 60, 2300));
      assert.strictEqual(atCap.mode, "walk");
    },
  ],
  [
    "escape hatch: walking at least TWICE as fast as transit wins at any length",
    () => {
      // broken transit (90 min with transfers/waits) vs a 35-min walk —
      // the cap must not force the worse ride
      const leg = buildLeg(0, mkRoute(90 * 60, 4000, { transitStep: true }), mkRoute(35 * 60, 2900));
      assert.strictEqual(leg.mode, "walk");
      assert.strictEqual(leg.totalMinutes, 35);
      // but a 35-min walk vs 45-min transit (not twice as fast) stays transit
      const leg2 = buildLeg(0, mkRoute(45 * 60, 4000, { transitStep: true }), mkRoute(35 * 60, 2900));
      assert.strictEqual(leg2.mode, "transit");
    },
  ],
  [
    "transit meaningfully faster than walking stays transit (real 501 Queen numbers)",
    () => {
      // live evidence: transit 25 min / 3064m vs walk 38 min / 2727m
      const leg = buildLeg(
        0,
        mkRoute(1500, 3064, { transitStep: true }),
        mkRoute(2280, 2727)
      );
      assert.strictEqual(leg.mode, "transit");
      assert.strictEqual(leg.rawMinutes, 25);
      assert.strictEqual(leg.totalMinutes, 25 + TRANSIT_MARGIN_MIN);
      assert.ok(leg.transit, "transit details must survive");
    },
  ],
  [
    "transit details extracted from computeRoutes steps (skipping non-transit steps)",
    () => {
      const leg = buildLeg(0, mkRoute(1080, 4200, { transitStep: true }), null);
      assert.strictEqual(leg.mode, "transit");
      assert.deepStrictEqual(leg.transit, {
        lineName: "506 Carlton",
        headsign: "East - Main Street Station",
        stopCount: 4,
        departStop: "Ossington Ave",
        arriveStop: "Yonge St",
      });
    },
  ],
  [
    "relabeled walk leg does NOT carry transit details; both modes carry polylines",
    () => {
      // short hop with transit details in the route — walk label wins,
      // details dropped, polyline kept
      const relabeled = buildLeg(0, mkRoute(180, 193, { transitStep: true, polyline: "enc_1" }), null);
      assert.strictEqual(relabeled.mode, "walk");
      assert.strictEqual(relabeled.transit, undefined);
      assert.strictEqual(relabeled.encodedPolyline, "enc_1");
      const walk = buildLeg(0, NO_ROUTE, mkRoute(300, 350, { polyline: "enc_2" }));
      assert.strictEqual(walk.encodedPolyline, "enc_2");
      const transit = buildLeg(0, mkRoute(900, 3000, { polyline: "enc_3" }), null);
      assert.strictEqual(transit.encodedPolyline, "enc_3");
    },
  ],
  [
    "schedule chain: travel inserted between stops, times sum correctly",
    () => {
      const legs = [
        buildLeg(0, mkRoute(1200, 12000), null), // 20 + 5 = 25
        buildLeg(1, mkRoute(480, 4800), null), // 8 + 5 = 13
      ];
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
      assert.strictEqual(stops[0].start_time, "2026-07-03T19:00:00-04:00");
      assert.strictEqual(stops[0].end_time, "2026-07-03T20:45:00-04:00");
      assert.strictEqual(stops[0].travelMinutesToNext, 25);
      assert.strictEqual(stops[0].travelToNext?.mode, "transit");
      assert.strictEqual(stops[1].start_time, "2026-07-03T21:10:00-04:00");
      assert.strictEqual(stops[1].end_time, "2026-07-03T22:20:00-04:00");
      assert.strictEqual(stops[1].travelMinutesToNext, 13);
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
