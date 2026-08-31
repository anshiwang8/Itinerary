// R1 step 2: POST /swap, POST /remove and POST /mode require verified
// ownership for an OWNED plan, and refuse every other caller with the SAME 404
// a missing plan returns. Unowned / legacy plans stay capability-by-id (mock
// e2e, the guest sign-in race). AUDIT_FINDINGS.md R1.
//
// Real route -> `enforceItineraryOwnership` -> `updateItinerary` -> engine.
// Only Firebase Admin is substituted (there is no way to mint a real ID token
// in a unit test); the store is the in-memory Map and the mutation engines run
// for real under E2E_MOCK, so a passing "owner succeeds" case proves the gate
// does not block the owner from the engine.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import {
  createItinerary,
  loadItinerary,
  saveItinerary,
  type Itinerary,
} from "./store";
import type { ScheduledStop } from "../schedule/schedule";
import type { TravelLeg } from "../schedule/travel";
import { resetRateLimitsForTests } from "../_shared/http";

for (const key of [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VERCEL",
]) {
  delete process.env[key];
}
process.env.E2E_MOCK = "1";

const nodeRequire = createRequire(import.meta.url);
const adminPath = nodeRequire.resolve("../../lib/firebaseAdmin");
const originalAdmin = nodeRequire.cache[adminPath];
nodeRequire.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: {
    isAdminConfigured: () => true,
    verifyIdToken: async (token: string) => {
      if (token === "owner-token") return { uid: "owner", isAnonymous: false };
      if (token === "stranger-token") return { uid: "stranger", isAnonymous: false };
      return null;
    },
    getAdminFirestore: () => null,
  },
} as NodeModule;

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) => Promise<Response>;

const { POST: swapRoute } = nodeRequire("./[id]/swap/route") as { POST: RouteHandler };
const { POST: removeRoute } = nodeRequire("./[id]/remove/route") as { POST: RouteHandler };
const { POST: modeRoute } = nodeRequire("./[id]/mode/route") as { POST: RouteHandler };

// ── fixture ────────────────────────────────────────────────────────────────
// A 3-stop transit plan, all stops upcoming relative to `NOW`, with locations
// and a home leg so the mock engines can price legs. The mutation payloads
// below each produce a real change under the mock deps.
const NOW = "2026-07-03T17:00:00-04:00";
const T = (h: number, m: number) =>
  `2026-07-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`;

function leg(fromIndex: number, totalMinutes = 10): TravelLeg {
  return {
    fromIndex,
    mode: "walk",
    rawMinutes: totalMinutes,
    marginMinutes: 0,
    totalMinutes,
    distanceMeters: 800,
    encodedPolyline: `leg-${fromIndex}`,
  };
}

function stops(): ScheduledStop[] {
  return [
    {
      category: "dinner",
      id: "d1",
      name: "Dinner",
      start_time: T(19, 0),
      end_time: T(20, 0),
      durationMinutes: { base: 50, buffer: 10, total: 60 },
      location: { latitude: 43.64, longitude: -79.43 },
      travelMinutesToNext: 10,
      travelToNext: leg(0),
    },
    {
      category: "bar",
      id: "b1",
      name: "Bar",
      start_time: T(20, 10),
      end_time: T(21, 20),
      durationMinutes: { base: 60, buffer: 10, total: 70 },
      location: { latitude: 43.641, longitude: -79.429 },
      travelMinutesToNext: 10,
      travelToNext: leg(1),
    },
    {
      category: "dessert",
      id: "s1",
      name: "Dessert",
      start_time: T(21, 30),
      end_time: T(22, 10),
      durationMinutes: { base: 30, buffer: 10, total: 40 },
      location: { latitude: 43.642, longitude: -79.428 },
    },
  ];
}

async function plan(overrides: Partial<Itinerary> = {}): Promise<Itinerary> {
  return saveItinerary({
    ...createItinerary(
      stops(),
      [leg(0), leg(1)],
      {
        time_window: "evening",
        stop_count: null,
        aesthetic: "calm",
        category_signals: ["dinner", "bar", "dessert"],
        group_context: "solo",
        budget: null,
        constraints: [],
        location: "Ossington",
      },
      leg(-1),
      { label: "Start", location: { latitude: 43.65, longitude: -79.4 } }
    ),
    ownerUid: "owner",
    ownerIsAnonymous: false,
    ...overrides,
  });
}

const UNOWNED: Partial<Itinerary> = { ownerUid: undefined, ownerIsAnonymous: undefined };

// ── route callers ─────────────────────────────────────────────────────────
interface Mutation {
  name: string;
  route: RouteHandler;
  body: Record<string, unknown>;
  okFlag: "swapped" | "removed" | "switched";
}

const MUTATIONS: Mutation[] = [
  { name: "swap", route: swapRoute, body: { stopIndex: 0, refinement: "cheaper" }, okFlag: "swapped" },
  { name: "remove", route: removeRoute, body: { stopIndex: 1 }, okFlag: "removed" },
  { name: "mode", route: modeRoute, body: { travelMode: "driving" }, okFlag: "switched" },
];

function callRoute(m: Mutation, id: string, token: string): Promise<Response> {
  resetRateLimitsForTests();
  return m.route(
    new NextRequest(`http://localhost:3200/api/itinerary/${id}/${m.name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ...m.body, now: NOW }),
    }),
    { params: Promise.resolve({ id }) }
  );
}

// ── the R1 matrix, run for every mutation route ────────────────────────────
const cases: Array<[string, () => Promise<void>]> = [];

for (const m of MUTATIONS) {
  cases.push([`R1 ${m.name}: the owner mutates their own plan and it applies`, async () => {
    const itinerary = await plan();
    const response = await callRoute(m, itinerary.id, "owner-token");
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body[m.okFlag], true, `${m.name} should have applied: ${JSON.stringify(body)}`);
    const stored = (await loadItinerary(itinerary.id))!;
    assert.ok(stored.version > itinerary.version, "a successful mutation bumps the persisted version");
  }]);

  cases.push([`R1 ${m.name}: a verified caller mutates an unowned/legacy plan`, async () => {
    const itinerary = await plan(UNOWNED);
    const response = await callRoute(m, itinerary.id, "owner-token");
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body[m.okFlag], true, JSON.stringify(body));
  }]);

  cases.push([`R1 ${m.name}: NO caller mutates an unowned plan (mock e2e's core case)`, async () => {
    for (const token of ["", "not-a-real-token"]) {
      const itinerary = await plan(UNOWNED);
      const response = await callRoute(m, itinerary.id, token);
      const body = await response.json();
      assert.equal(response.status, 200, `token=${JSON.stringify(token)}: ${JSON.stringify(body)}`);
      assert.equal(body[m.okFlag], true, JSON.stringify(body));
    }
  }]);

  cases.push([`R1 ${m.name}: a different verified owner gets a 404 and the plan is untouched`, async () => {
    const itinerary = await plan();
    const refused = await callRoute(m, itinerary.id, "stranger-token");
    const missing = await callRoute(m, "does-not-exist", "stranger-token");
    assert.equal(refused.status, 404);
    assert.equal(missing.status, 404);
    const [refusedBody, missingBody] = [await refused.json(), await missing.json()];
    assert.equal(refusedBody.code, "itinerary_not_found");
    assert.equal(refusedBody.error, missingBody.error);
    assert.deepEqual(
      Object.keys(refusedBody).sort(),
      Object.keys(missingBody).sort(),
      "a refusal must not carry a field a genuine 404 lacks"
    );
    assert.equal(refused.headers.get("etag"), null, "no ETag on a refusal");
    assert.deepEqual(await loadItinerary(itinerary.id), itinerary, "no partial mutation");
  }]);

  cases.push([`R1 ${m.name}: NO caller mutating an OWNED plan is refused (the fix)`, async () => {
    const itinerary = await plan();
    const response = await callRoute(m, itinerary.id, "");
    assert.equal(response.status, 404, "an unauthenticated stranger can no longer mutate an owned plan");
    assert.equal((await response.json()).code, "itinerary_not_found");
    assert.deepEqual(await loadItinerary(itinerary.id), itinerary, "the plan is not mutated");
  }]);
}

void (async () => {
  let failed = 0;
  try {
    for (const [caseName, run] of cases) {
      try {
        await run();
        console.log(`PASS  ${caseName}`);
      } catch (error) {
        failed++;
        console.log(`FAIL  ${caseName}`);
        console.log(error instanceof Error ? error.stack : error);
      }
    }
  } finally {
    if (originalAdmin) nodeRequire.cache[adminPath] = originalAdmin;
    else delete nodeRequire.cache[adminPath];
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed) process.exitCode = 1;
})();
