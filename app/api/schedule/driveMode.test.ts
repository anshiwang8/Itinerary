// Drive-vs-transit mode, Stage 1: the plan-level travel mode, the driving
// relabel/margin POLICY, and the mode-aware provider request.
// Run with: npx tsx app/api/schedule/driveMode.test.ts
import assert from "node:assert";
import {
  ComputeRoutesResponse,
  DRIVING_MARGIN_MIN,
  DRIVING_SHORT_LEG_WALK_METERS,
  LatLng,
  TRANSIT_MARGIN_MIN,
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

/**
 * Capture the FULL parsed request body of every Routes call, keyed by mode.
 *
 * `recordModes` above reads `travelMode` and nothing else, which is exactly
 * how a DRIVE request the provider REJECTS passed a full `npm run check`:
 * the assertion was that we asked for a drive, never that the ask was legal.
 */
async function recordBodies(
  run: () => Promise<unknown>,
  respond: (mode: string, body: Record<string, unknown>) => Response
): Promise<Record<string, Record<string, unknown>>> {
  const bodies: Record<string, Record<string, unknown>> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("routes.googleapis.com")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const mode = String(body.travelMode);
      bodies[mode] = body;
      return respond(mode, body);
    }
    return realFetch(url as never, init);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies;
}

/**
 * A stub that rejects the way the REAL Routes v2 API rejects. Both rules are
 * transcribed from a live probe, and each one is a 400 the app used to eat:
 *  - DRIVE + departureTime with NO routingPreference → "Timestamp cannot be
 *    set for TRAFFIC_UNAWARE routing mode" (DRIVE defaults to
 *    TRAFFIC_UNAWARE, where a timestamp is illegal);
 *  - WALK or TRANSIT carrying routingPreference → "Routing preference cannot
 *    be set for WALK or BICYCLE" / "... for TRANSIT".
 * The canned 200 `ok` gives can express neither, so a test using it proves
 * only what we sent, never that it would be accepted.
 */
const strict = (mode: string, body: Record<string, unknown>): Response => {
  const illegal =
    mode === "DRIVE"
      ? body.departureTime !== undefined && body.routingPreference === undefined
      : body.routingPreference !== undefined;
  if (!illegal) return ok(mode);
  return new Response(
    JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT" } }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
};

/** An hour out, so `computeRoute` actually attaches it. */
const SOON = new Date(Date.now() + 60 * 60_000).toISOString();

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
    "a DRIVE carrying a departureTime also carries routingPreference",
    async () => {
      const bodies = await recordBodies(
        () => getTravelLegs("k", FAR, SOON, [], undefined, "driving"),
        (mode) => ok(mode)
      );
      assert.strictEqual(bodies.DRIVE?.departureTime, SOON, "the leg is priced at its own departure");
      assert.strictEqual(
        bodies.DRIVE?.routingPreference,
        "TRAFFIC_AWARE",
        "without it Routes v2 defaults to TRAFFIC_UNAWARE and 400s the timestamp"
      );
      // BILLING PIN: TRAFFIC_AWARE_OPTIMAL fixes the same 400 but escalates
      // the call to the Routes Preferred SKU. Moving to it must be a
      // deliberate edit here, not a quiet upgrade.
      assert.notStrictEqual(bodies.DRIVE?.routingPreference, "TRAFFIC_AWARE_OPTIMAL");
    },
  ],
  [
    "routingPreference NEVER reaches a WALK or TRANSIT request",
    async () => {
      // The other half of the same 400: these modes reject a routing
      // preference outright, so the driving plan's WALK sibling must stay
      // clean or the short-hop relabel loses its route too.
      const driving = await recordBodies(
        () => getTravelLegs("k", FAR, SOON, [], undefined, "driving"),
        (mode) => ok(mode)
      );
      assert.strictEqual(driving.WALK?.routingPreference, undefined, "WALK forbids it");

      const transit = await recordBodies(
        () => getTravelLegs("k", FAR, SOON),
        (mode) => ok(mode)
      );
      assert.strictEqual(transit.TRANSIT?.routingPreference, undefined, "TRANSIT forbids it");
      assert.strictEqual(transit.WALK?.routingPreference, undefined);
      // Byte-identity, stated as the strongest offline form: a transit plan's
      // request bodies carry exactly the keys they carried before drive mode.
      for (const mode of ["TRANSIT", "WALK"]) {
        assert.deepStrictEqual(
          Object.keys(transit[mode]).sort(),
          ["departureTime", "destination", "origin", "travelMode"],
          `${mode} request body is unchanged`
        );
      }
    },
  ],
  [
    "against a provider that enforces its real contract, a DRIVE still prices",
    async () => {
      // The end-to-end shape of the bug: with `strict` answering, the old
      // body 400s, the DRIVE leg comes back null, and buildDrivingLeg falls
      // through to WALK — a 30 min drive scheduled as a 30 min walk.
      let legs: Awaited<ReturnType<typeof getTravelLegs>> = [];
      await recordBodies(async () => {
        legs = await getTravelLegs("k", FAR, SOON, [], undefined, "driving");
      }, strict);
      assert.strictEqual(legs[0].mode, "driving", "not the walk fallback");
      assert.strictEqual(legs[0].rawMinutes, 10, "the provider's DRIVE duration");
      assert.strictEqual(legs[0].totalMinutes, 10 + DRIVING_MARGIN_MIN);
      assert.strictEqual(legs[0].distanceMeters, 4_200);
      assert.strictEqual(legs[0].encodedPolyline, "enc_drive", "real road geometry");
    },
  ],
  [
    "the same enforcing provider leaves a TRANSIT plan priced as transit",
    async () => {
      // The reverse regression: a leaked routingPreference would 400 both
      // transit requests and silently downgrade every transit plan.
      let legs: Awaited<ReturnType<typeof getTravelLegs>> = [];
      await recordBodies(async () => {
        legs = await getTravelLegs("k", FAR, SOON);
      }, strict);
      assert.strictEqual(legs[0].mode, "transit");
      assert.strictEqual(legs[0].totalMinutes, 10 + TRANSIT_MARGIN_MIN);
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
