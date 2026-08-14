// Unit tests for travel legs (computeRoutes) + schedule integration.
// Run with: npx tsx app/api/schedule/travel.test.ts
import assert from "node:assert";
import {
  buildLeg,
  ComputeRoutesResponse,
  FALLBACK_WALK_DETOUR_FACTOR,
  FALLBACK_WALK_MIN_UNCERTAINTY_MIN,
  FALLBACK_WALK_UNCERTAINTY_RATIO,
  getTravelLegs,
  MAX_WALK_LABEL_MIN,
  SHORT_LEG_WALK_METERS,
  TRANSIT_SKIP_HAVERSINE_METERS,
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

// The board/alight instants and stop coordinates arrive under the SAME
// field mask (routes.legs.steps.transitDetails is a parent path) and were
// being dropped at the parser. A ride that publishes none of them keeps
// these four nulls — honest absence, never an invented time or place.
const NO_PROVIDER_TIMES = {
  boardISO: null,
  alightISO: null,
  boardLocation: null,
  alightLocation: null,
};

/** A two-ride journey WITH the provider's stop times and coordinates, in
 *  the exact nesting computeRoutes returns them. */
const MULTI_RIDE_WITH_TIMES: ComputeRoutesResponse = {
  routes: [
    {
      duration: "2700s",
      distanceMeters: 11400,
      polyline: { encodedPolyline: "enc_times" },
      legs: [
        {
          steps: [
            { transitDetails: undefined }, // walk to the stop
            {
              transitDetails: {
                headsign: "Eglinton Station",
                stopCount: 15,
                transitLine: { name: "Ossington", nameShort: "63" },
                stopDetails: {
                  departureStop: {
                    name: "Ossington Ave at Dundas",
                    location: { latLng: { latitude: 43.6501, longitude: -79.4204 } },
                  },
                  arrivalStop: {
                    name: "Ossington Station",
                    location: { latLng: { latitude: 43.6624, longitude: -79.4262 } },
                  },
                  departureTime: "2026-07-03T23:07:00Z",
                  arrivalTime: "2026-07-03T23:24:00Z",
                },
              },
            },
            { transitDetails: undefined }, // the transfer walk
            {
              transitDetails: {
                headsign: "Kennedy",
                stopCount: 6,
                transitLine: { name: "Line 2 Bloor–Danforth", nameShort: "2" },
                stopDetails: {
                  departureStop: {
                    name: "Ossington Station",
                    location: { latLng: { latitude: 43.6626, longitude: -79.4264 } },
                  },
                  arrivalStop: {
                    name: "Yonge Station",
                    location: { latLng: { latitude: 43.6709, longitude: -79.3857 } },
                  },
                  departureTime: "2026-07-03T23:29:00Z",
                  arrivalTime: "2026-07-03T23:41:00Z",
                },
              },
            },
            { transitDetails: undefined }, // walk to the venue
          ],
        },
      ],
    },
  ],
};
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
        shortName: "506",
        color: null, // unpublished in this fixture — keep-on-missing
        textColor: null,
        vehicle: null,
        headsign: "East - Main Street Station",
        stopCount: 4,
        departStop: "Ossington Ave",
        arriveStop: "Yonge St",
        // this fixture's stopDetails carry names only
        ...NO_PROVIDER_TIMES,
      });
      // the singular field IS the first segment — same object shape, so
      // old readers and the new array can't disagree
      assert.deepStrictEqual(leg.transitSegments, [leg.transit]);
    },
  ],
  [
    "MULTI-RIDE extraction: every transit step survives, in riding order, colors carried",
    () => {
      // the shape extractTransitSummary used to throw away: a two-transfer
      // journey (bus → subway → streetcar) with walk steps interleaved.
      // Line data mirrors a real probe: TTC colors on the first two, the
      // third publishes no color (keep-on-missing → nulls).
      const res: ComputeRoutesResponse = {
        routes: [
          {
            duration: "4272s",
            distanceMeters: 14200,
            polyline: { encodedPolyline: "enc_multi" },
            legs: [
              {
                steps: [
                  { transitDetails: undefined }, // walk to the stop
                  {
                    transitDetails: {
                      headsign: "Eglinton Station",
                      stopCount: 15,
                      transitLine: {
                        name: "Ossington",
                        nameShort: "63",
                        color: "#ed1c24",
                        textColor: "#ffffff",
                        vehicle: { type: "BUS" },
                      },
                    },
                  },
                  { transitDetails: undefined }, // transfer walk
                  {
                    transitDetails: {
                      headsign: "Kennedy",
                      stopCount: 20,
                      transitLine: {
                        name: "Line 2 Bloor–Danforth",
                        nameShort: "2",
                        color: "#009247",
                        textColor: "#ffffff",
                        vehicle: { type: "SUBWAY" },
                      },
                    },
                  },
                  {
                    transitDetails: {
                      headsign: "Neville Park",
                      stopCount: 6,
                      transitLine: { name: "501 Queen", nameShort: "501" },
                    },
                  },
                  { transitDetails: undefined }, // walk to the venue
                ],
              },
            ],
          },
        ],
      };
      const leg = buildLeg(0, res, null);
      assert.strictEqual(leg.mode, "transit");
      assert.strictEqual(leg.transitSegments?.length, 3, "all three rides must survive");
      assert.deepStrictEqual(
        leg.transitSegments!.map((s) => s.lineName),
        // middle line keeps its bare name: the "avoid 501 501 Queen"
        // dedup sees "2" already inside "Line 2 Bloor–Danforth"
        ["63 Ossington", "Line 2 Bloor–Danforth", "501 Queen"],
        "riding order preserved"
      );
      assert.deepStrictEqual(
        leg.transitSegments!.map((s) => [s.shortName, s.color, s.vehicle]),
        [
          ["63", "#ed1c24", "BUS"],
          ["2", "#009247", "SUBWAY"],
          ["501", null, null], // no published color/vehicle → nulls, never dropped
        ]
      );
      // compat: the singular field is still exactly the FIRST ride
      assert.deepStrictEqual(leg.transit, leg.transitSegments![0]);
    },
  ],
  [
    "provider board/alight INSTANTS survive onto the ride (they already arrived; the parser dropped them)",
    () => {
      const leg = buildLeg(0, MULTI_RIDE_WITH_TIMES, null);
      assert.strictEqual(leg.mode, "transit");
      assert.deepStrictEqual(
        leg.transitSegments!.map((s) => [s.boardISO, s.alightISO]),
        [
          ["2026-07-03T23:07:00Z", "2026-07-03T23:24:00Z"],
          ["2026-07-03T23:29:00Z", "2026-07-03T23:41:00Z"],
        ],
        "each ride carries ITS OWN board and alight time"
      );
      // the singular compat field is still exactly the first ride
      assert.strictEqual(leg.transit?.boardISO, "2026-07-03T23:07:00Z");
      // and none of this touched what the leg is scheduled on: 45 min of
      // provider duration plus the boarding margin, exactly as before
      assert.strictEqual(leg.rawMinutes, 45);
      assert.strictEqual(leg.totalMinutes, 45 + TRANSIT_MARGIN_MIN);
    },
  ],
  [
    "provider stop COORDINATES survive onto the ride — the transfer point is a real place",
    () => {
      const leg = buildLeg(0, MULTI_RIDE_WITH_TIMES, null);
      const [first, second] = leg.transitSegments!;
      assert.deepStrictEqual(first.boardLocation, {
        latitude: 43.6501,
        longitude: -79.4204,
      });
      // where ride 1 ends and ride 2 begins: the transfer, at the
      // provider's own coordinates for each side of it
      assert.deepStrictEqual(first.alightLocation, {
        latitude: 43.6624,
        longitude: -79.4262,
      });
      assert.deepStrictEqual(second.boardLocation, {
        latitude: 43.6626,
        longitude: -79.4264,
      });
      assert.deepStrictEqual(second.alightLocation, {
        latitude: 43.6709,
        longitude: -79.3857,
      });
    },
  ],
  [
    "a response WITHOUT stop times/coordinates yields nulls — no throw, no fabrication",
    () => {
      // mkRoute's stopDetails carry names only, which is a real provider
      // shape: plenty of rides publish no scheduled times.
      const leg = buildLeg(0, mkRoute(1080, 4200, { transitStep: true }), null);
      const ride = leg.transit!;
      assert.strictEqual(ride.boardISO, null);
      assert.strictEqual(ride.alightISO, null);
      assert.strictEqual(ride.boardLocation, null);
      assert.strictEqual(ride.alightLocation, null);
      // the names it DOES publish are untouched — this is additive
      assert.strictEqual(ride.departStop, "Ossington Ave");
      assert.strictEqual(ride.arriveStop, "Yonge St");
    },
  ],
  [
    "junk times and half-coordinates are DROPPED rather than carried",
    () => {
      const res: ComputeRoutesResponse = {
        routes: [
          {
            duration: "900s",
            distanceMeters: 3000,
            legs: [
              {
                steps: [
                  {
                    transitDetails: {
                      transitLine: { name: "501 Queen", nameShort: "501" },
                      stopDetails: {
                        departureStop: {
                          name: "Queen St",
                          // longitude missing — half a coordinate is not a place
                          location: { latLng: { latitude: 43.65 } },
                        },
                        arrivalStop: {
                          name: "Broadview",
                          // out of range — a provider can't publish this
                          location: { latLng: { latitude: 43.65, longitude: 999 } },
                        },
                        departureTime: "not a time",
                        arrivalTime: "",
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      const ride = buildLeg(0, res, null).transit!;
      assert.deepStrictEqual(
        [ride.boardISO, ride.alightISO, ride.boardLocation, ride.alightLocation],
        [null, null, null, null],
        "unreadable values become null; a marker is never drawn at a guess"
      );
      assert.strictEqual(ride.lineName, "501 Queen", "the rest of the ride survives");
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

// ── per-leg departure times (code-audit 2026-07-18 §1.5) ──
// Every leg used to be routed with the OUTING's start time, so a late leg
// got early-evening transit frequencies (and sometimes services that had
// stopped running). Each leg must depart at its own estimated instant.
const asyncCases: Array<[string, () => Promise<void>]> = [
  [
    "Routes failure over irregular geography gets a detour-adjusted uncertain estimate",
    async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("routes.googleapis.com")) {
          // both TRANSIT and WALK fail — Routes outage
          return new Response(JSON.stringify({ error: { message: "unavailable" } }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        // Toronto Island to the waterfront is close as the crow flies but
        // water makes that distance especially unrepresentative of a
        // walkable path. A Routes outage must not turn it into an
        // optimistic straight-line promise.
        const legs = await getTravelLegs("k", [
          { latitude: 43.6205, longitude: -79.3786 },
          { latitude: 43.6416, longitude: -79.3777 },
        ]);
        assert.strictEqual(legs.length, 1);
        const leg = legs[0];
        assert.strictEqual(leg.mode, "unknown", "honest about not knowing");
        const directWalkMinutes =
          ((leg.distanceMeters ?? 0) / 1000 / 5) * 60;
        assert.ok(
          FALLBACK_WALK_DETOUR_FACTOR >= 1.3,
          "the fallback policy keeps at least a 30% network-detour allowance"
        );
        assert.ok(
          FALLBACK_WALK_UNCERTAINTY_RATIO >= 0.2,
          "the fallback policy keeps at least 20% uncertainty"
        );
        assert.ok(
          FALLBACK_WALK_MIN_UNCERTAINTY_MIN >= 5,
          "even a nearby failed route keeps at least five uncertain minutes"
        );
        assert.ok(
          leg.rawMinutes >= Math.ceil(directWalkMinutes * 1.3),
          "raw fallback includes the street-network detour factor"
        );
        assert.ok(
          leg.marginMinutes >= Math.max(5, Math.ceil(leg.rawMinutes * 0.2)),
          "uncertainty is a separate, inspectable margin"
        );
        assert.strictEqual(
          leg.totalMinutes,
          leg.rawMinutes + leg.marginMinutes
        );
        assert.ok(
          leg.totalMinutes > directWalkMinutes,
          "fallback must be more conservative than crow-flies walking time"
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "short hop requests WALK once and omits TRANSIT upstream",
    async () => {
      const modes: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("routes.googleapis.com")) {
          const body = JSON.parse(String(init?.body));
          modes.push(body.travelMode);
          return new Response(
            JSON.stringify({
              routes: [
                {
                  duration: "120s",
                  distanceMeters: 180,
                  polyline: { encodedPolyline: "enc_short_walk" },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        const origin = { latitude: 43.65, longitude: -79.4 };
        const destination = { latitude: 43.651, longitude: -79.4 };
        const legs = await getTravelLegs("k", [origin, destination]);
        assert.strictEqual(
          TRANSIT_SKIP_HAVERSINE_METERS,
          250,
          "the provider-call policy keeps the audited conservative threshold"
        );
        assert.ok(
          TRANSIT_SKIP_HAVERSINE_METERS < SHORT_LEG_WALK_METERS,
          "the provider-skip threshold stays stricter than route relabeling"
        );
        assert.deepStrictEqual(modes, ["WALK"], "one upstream request; no TRANSIT");
        assert.strictEqual(legs[0].mode, "walk");
        assert.strictEqual(legs[0].encodedPolyline, "enc_short_walk");
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "getTravelLegs: each leg departs at its OWN accumulated instant",
    async () => {
      const departures: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("routes.googleapis.com")) {
          const body = JSON.parse(String(init?.body));
          if (body.travelMode === "TRANSIT") departures.push(body.departureTime ?? "(none)");
          // transit 10 min, walk 50 min → the leg stays TRANSIT (and so
          // carries the 5-minute boarding margin)
          return new Response(
            JSON.stringify({
              routes: [
                {
                  duration: body.travelMode === "TRANSIT" ? "600s" : "3000s",
                  distanceMeters: 5000,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        const pts = [
          { latitude: 43.65, longitude: -79.4 },
          { latitude: 43.66, longitude: -79.41 },
          { latitude: 43.67, longitude: -79.42 },
        ];
        // leave home at 23:00Z, stay 105 min at the first stop
        const start = "2030-07-03T23:00:00.000Z";
        const legs = await getTravelLegs("k", pts, start, [0, 105, 70]);
        assert.strictEqual(legs.length, 2);
        assert.strictEqual(departures.length, 2, "one TRANSIT call per leg");
        // leg 0 departs at the outing start
        assert.strictEqual(departures[0], start);
        // leg 1 departs after leg 0's travel (10 min + 5 margin) AND the
        // 105-minute stay: 23:00 + 15 + 105 = 01:00 next day
        assert.strictEqual(departures[1], "2030-07-04T01:00:00.000Z");
        assert.notStrictEqual(
          departures[0],
          departures[1],
          "legs must not share a departure time"
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
];

(async () => {
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
  for (const [name, fn] of asyncCases) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${err instanceof Error ? err.message : err}`);
    }
  }
  const total = cases.length + asyncCases.length;
  console.log(`\n${total - failed}/${total} passed`);
  if (failed > 0) process.exit(1);
})();
