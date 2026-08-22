// Drive-vs-transit mode, Stage 1: the plan-level travel mode, the driving
// relabel/margin POLICY, and the mode-aware provider request.
// Run with: npx tsx app/api/schedule/driveMode.test.ts
import assert from "node:assert";
import {
  ComputeRoutesResponse,
  DRIVING_MARGIN_MIN,
  DRIVING_SHORT_LEG_WALK_METERS,
  LatLng,
  buildDrivingLeg,
  getTravelLegs,
  isPlanTravelMode,
} from "./travel";

/** A computeRoutes response with the fields buildDrivingLeg reads. */
function mkRoute(
  seconds: number,
  meters: number,
  polyline = "enc_drive"
): ComputeRoutesResponse {
  return {
    routes: [
      {
        duration: `${seconds}s`,
        distanceMeters: meters,
        polyline: { encodedPolyline: polyline },
      },
    ],
  };
}

/** Capture the travelMode of every Routes request a call makes. */
async function recordModes(
  run: () => Promise<unknown>,
  respond: (mode: string) => Response
): Promise<string[]> {
  const modes: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("routes.googleapis.com")) {
      const mode = String(JSON.parse(String(init?.body)).travelMode);
      modes.push(mode);
      return respond(mode);
    }
    return realFetch(url as never, init);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
  return modes;
}

const ok = (mode: string) =>
  new Response(
    JSON.stringify(
      mkRoute(mode === "WALK" ? 1_800 : 600, mode === "WALK" ? 2_400 : 4_200)
    ),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

const dead = () =>
  new Response(JSON.stringify({ error: { message: "unavailable" } }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

// Two points ~4 km apart — comfortably past every relabel threshold.
const FAR: LatLng[] = [
  { latitude: 43.6426, longitude: -79.3871 },
  { latitude: 43.6786, longitude: -79.3871 },
];

const cases: Array<[string, () => void]> = [
  [
    "the plan-mode allowlist accepts exactly transit and driving",
    () => {
      assert.strictEqual(isPlanTravelMode("transit"), true);
      assert.strictEqual(isPlanTravelMode("driving"), true);
      for (const bad of ["walk", "DRIVE", "cycling", "", null, undefined, 1, {}]) {
        assert.strictEqual(isPlanTravelMode(bad), false, `rejects ${String(bad)}`);
      }
    },
  ],
  [
    "a driving leg is the provider's DRIVE duration plus the labelled margin",
    () => {
      const leg = buildDrivingLeg(0, mkRoute(720, 5_400), mkRoute(4_200, 5_100));
      assert.strictEqual(leg.mode, "driving");
      assert.strictEqual(leg.rawMinutes, 12, "provider fact, unmodified");
      assert.strictEqual(
        leg.marginMinutes,
        DRIVING_MARGIN_MIN,
        "the park/approach allowance is its own inspectable field"
      );
      assert.strictEqual(leg.totalMinutes, 12 + DRIVING_MARGIN_MIN);
      assert.strictEqual(leg.distanceMeters, 5_400);
      assert.strictEqual(leg.encodedPolyline, "enc_drive");
    },
  ],
  [
    "DRIVING_MARGIN_MIN is a policy estimate, not a measurement, and stays 10",
    () => {
      // Pinned so a later "let's source real parking data" change has to be a
      // deliberate edit here rather than a quiet drift in the constant.
      assert.strictEqual(DRIVING_MARGIN_MIN, 10);
      assert.ok(
        DRIVING_MARGIN_MIN > 0,
        "leaving and parking is never free, so the margin is never zero"
      );
    },
  ],
  [
    "a driving leg under the short-hop threshold relabels to WALK",
    () => {
      const meters = DRIVING_SHORT_LEG_WALK_METERS - 1;
      const leg = buildDrivingLeg(2, mkRoute(180, meters), mkRoute(480, meters));
      assert.strictEqual(
        leg.mode,
        "walk",
        "a driving PLAN legitimately contains walk legs — mode is plan-level intent"
      );
      assert.strictEqual(leg.rawMinutes, 8, "the WALK route's own minutes");
      assert.strictEqual(leg.marginMinutes, 0, "walking takes no driving margin");
      assert.strictEqual(leg.totalMinutes, 8);
    },
  ],
  [
    "at the threshold exactly, the leg is still a drive",
    () => {
      const leg = buildDrivingLeg(
        0,
        mkRoute(300, DRIVING_SHORT_LEG_WALK_METERS),
        mkRoute(600, DRIVING_SHORT_LEG_WALK_METERS)
      );
      assert.strictEqual(leg.mode, "driving", "the rule is strictly-below");
    },
  ],
  [
    "the driving threshold is higher than transit's, and both are policy",
    () => {
      assert.strictEqual(DRIVING_SHORT_LEG_WALK_METERS, 700);
      assert.ok(
        DRIVING_SHORT_LEG_WALK_METERS > 400,
        "park-and-approach makes a short drive worse than a short transit hop"
      );
    },
  ],
  [
    "a short drive with NO walk route stays a drive rather than inventing walk minutes",
    () => {
      const leg = buildDrivingLeg(0, mkRoute(120, 300), null);
      assert.strictEqual(leg.mode, "driving");
      assert.strictEqual(
        leg.totalMinutes,
        2 + DRIVING_MARGIN_MIN,
        "a car's duration must never be presented as a walk's"
      );
    },
  ],
  [
    "the drive not pricing falls to the real WALK route",
    () => {
      const leg = buildDrivingLeg(1, null, mkRoute(900, 1_200, "enc_walk"));
      assert.strictEqual(leg.mode, "walk");
      assert.strictEqual(leg.totalMinutes, 15);
      assert.strictEqual(leg.encodedPolyline, "enc_walk");
    },
  ],
  [
    "neither mode pricing leaves an unpriceable driving leg honestly unknown",
    () => {
      const leg = buildDrivingLeg(0, null, null);
      assert.strictEqual(leg.mode, "unknown");
      // THE PINNED RULE: no walk-speed estimate on a driving plan. Crow-flies
      // distance at walking pace is 3-6x a car's time — a number nothing
      // measured, and wrong in the direction that matters.
      assert.strictEqual(leg.rawMinutes, 0);
      assert.strictEqual(leg.marginMinutes, 0);
      assert.strictEqual(leg.totalMinutes, 0);
      assert.strictEqual(
        leg.distanceMeters,
        null,
        "no invented driving distance either"
      );
    },
  ],
  [
    "a driving leg carries no transit decorations to degrade",
    () => {
      const leg = buildDrivingLeg(0, mkRoute(600, 4_000), mkRoute(3_000, 3_800));
      assert.strictEqual(leg.transit, undefined);
      assert.strictEqual(leg.transitSegments, undefined);
      assert.strictEqual(
        leg.pathSegments,
        undefined,
        "pathSegments is transit-shaped; a DRIVE step is never guessed into one"
      );
    },
  ],
  [
    "every driving leg keeps its own app-owned identity",
    () => {
      const a = buildDrivingLeg(0, mkRoute(600, 4_000), null);
      const b = buildDrivingLeg(1, mkRoute(600, 4_000), null);
      assert.ok(typeof a.legId === "string" && a.legId.length > 0);
      assert.notStrictEqual(a.legId, b.legId);
    },
  ],
];

const asyncCases: Array<[string, () => Promise<void>]> = [
  [
    "a DRIVING plan asks the provider for DRIVE (and WALK), never TRANSIT",
    async () => {
      let legs: Awaited<ReturnType<typeof getTravelLegs>> = [];
      const modes = await recordModes(async () => {
        legs = await getTravelLegs("k", FAR, undefined, [], undefined, "driving");
      }, ok);
      assert.deepStrictEqual(
        [...modes].sort(),
        ["DRIVE", "WALK"],
        "DRIVE is requested; WALK rides along so a short hop can still relabel"
      );
      assert.ok(!modes.includes("TRANSIT"), "a driving plan never routes transit");
      assert.strictEqual(legs[0].mode, "driving");
      assert.strictEqual(legs[0].totalMinutes, 10 + DRIVING_MARGIN_MIN);
    },
  ],
  [
    "a TRANSIT plan is unchanged — TRANSIT + WALK, and no DRIVE",
    async () => {
      let legs: Awaited<ReturnType<typeof getTravelLegs>> = [];
      const modes = await recordModes(async () => {
        legs = await getTravelLegs("k", FAR);
      }, ok);
      assert.deepStrictEqual([...modes].sort(), ["TRANSIT", "WALK"]);
      assert.ok(!modes.includes("DRIVE"), "the default plan mode is transit");
      assert.strictEqual(legs[0].mode, "transit");
    },
  ],
  [
    "an omitted plan mode routes as transit — absent means transit end to end",
    async () => {
      const modes = await recordModes(
        () => getTravelLegs("k", FAR, undefined, [], undefined, undefined),
        ok
      );
      assert.ok(modes.includes("TRANSIT"));
      assert.ok(!modes.includes("DRIVE"));
    },
  ],
  [
    "a Routes outage on a DRIVING plan produces no walk-speed estimate",
    async () => {
      let legs: Awaited<ReturnType<typeof getTravelLegs>> = [];
      await recordModes(async () => {
        legs = await getTravelLegs("k", FAR, undefined, [], undefined, "driving");
      }, dead);
      assert.strictEqual(legs[0].mode, "unknown");
      assert.strictEqual(legs[0].totalMinutes, 0);
      assert.strictEqual(legs[0].distanceMeters, null);
    },
  ],
  [
    "the same outage on a TRANSIT plan still gets its conservative estimate",
    async () => {
      // Regression guard on the §6.2 fallback: drive mode must not weaken it.
      let legs: Awaited<ReturnType<typeof getTravelLegs>> = [];
      await recordModes(async () => {
        legs = await getTravelLegs("k", FAR);
      }, dead);
      assert.strictEqual(legs[0].mode, "unknown");
      assert.ok(legs[0].totalMinutes > 0, "transit keeps the walk-speed floor");
      assert.ok((legs[0].distanceMeters ?? 0) > 0);
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
