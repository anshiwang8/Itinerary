// Real POST -> validation -> store -> GET -> rebuildLegs; no provider calls.
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { GET } from "./[id]/route";
import { loadItinerary, rebuildLegs, updateItinerary, type Itinerary } from "./store";
import { resetRateLimitsForTests } from "../_shared/http";
import { parseScheduledStops } from "../_shared/schemas";
import { parseItineraryPayload } from "../../lib/clientPayloads";
import type { TravelLeg } from "../schedule/travel";
import type { ScheduledStop } from "../schedule/schedule";

for (const key of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "VERCEL"]) {
  delete process.env[key];
}
process.env.E2E_MOCK = "1";

const stop = {
  id: "first", category: "dinner", name: "Dinner",
  start_time: "2026-07-10T19:00:00-04:00", end_time: "2026-07-10T20:00:00-04:00",
  durationMinutes: { base: 50, buffer: 10, total: 60 },
};
const last = { ...stop, id: "last", category: "bar", name: "Bar",
  start_time: "2026-07-10T20:10:00-04:00", end_time: "2026-07-10T21:10:00-04:00" };
const skipped = { id: null, category: "park", start_time: null, end_time: null, durationMinutes: null };
const walk: TravelLeg = { fromIndex: 0, mode: "walk", rawMinutes: 10, marginMinutes: 0,
  totalMinutes: 10, distanceMeters: 500, encodedPolyline: null };
const ride = { lineName: "Line 1", shortName: "1", vehicle: "SUBWAY", headsign: "North", color: "#123456",
  textColor: "#FFFFFF", departStop: "A", arriveStop: "B", stopCount: 2 };
function transit(legId: string, rideId: string, slot: number, fromIndex = 0): TravelLeg {
  const fact = { ...ride, rideId, sourceStepIndex: 0, paletteSlot: slot };
  return { ...walk, fromIndex, legId, mode: "transit", transit: fact, transitSegments: [fact] };
}
function body(leg: TravelLeg = walk): { stops: ScheduledStop[]; legs: TravelLeg[] } {
  return { stops: [{ ...stop, travelToNext: structuredClone(leg) }, { ...last }], legs: [structuredClone(leg)] };
}
async function post(payload: unknown) {
  resetRateLimitsForTests();
  return POST(new NextRequest("http://localhost:3200/api/itinerary", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }));
}
async function rejected(payload: unknown, reason: RegExp) {
  const response = await post(payload);
  const result = await response.json();
  assert.equal(response.status, 400, JSON.stringify(result));
  assert.equal(result.code, "invalid_request");
  assert.match(result.error, reason);
  assert.equal(result.id, undefined, "a refused request returns no persisted plan");
}
async function stored(payload: unknown): Promise<Itinerary> {
  const response = await post(payload);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const loaded = await loadItinerary(result.id);
  assert(loaded);
  return loaded;
}
async function read(plan: Itinerary): Promise<Itinerary> {
  const response = await GET(new NextRequest(`http://localhost:3200/api/itinerary/${plan.id}?now=2026-07-10T22:00:00Z`),
    { params: Promise.resolve({ id: plan.id }) });
  assert.equal(response.status, 200);
  return parseItineraryPayload(await response.json());
}
async function persistRebuild(plan: Itinerary): Promise<void> {
  await updateItinerary(plan.id, (proposal) => {
    rebuildLegs(proposal);
    return { value: null };
  });
}

const cases: Array<[string, () => void | Promise<void>]> = [
  ["audit D2: negative nested minutes with empty top-level legs are refused", async () => {
    await rejected({ stops: [{ ...stop, travelToNext: { ...walk, totalMinutes: -7 } }], legs: [] }, /travelToNext.*totalMinutes/);
  }],
  ["negative nested minutes are refused even when the corresponding top-level leg is valid", async () => {
    const payload = body();
    payload.stops[0].travelToNext!.totalMinutes = -7;
    await rejected(payload, /travelToNext.*totalMinutes/);
  }],
  ["the stop parser itself rejects malformed nested facts and sanitizes decorations", () => {
    for (const corrupt of [null, "walk", { ...walk, totalMinutes: -7 },
      { ...walk, transit: { ...ride, boardLocation: { latitude: 91, longitude: 0 } } },
      { ...walk, transit: { ...ride, rideId: "partial" } },
      { ...walk, pathSegments: "not-an-array" }]) {
      assert.throws(() => parseScheduledStops([{ ...stop, travelToNext: corrupt }]));
    }
    const parsed = parseScheduledStops([{ ...stop, travelToNext: { ...walk, pathSegments: [
      { mode: "walk", encodedPolyline: "" }, { mode: "walk", encodedPolyline: "valid", ignored: "drop" },
    ] } }]);
    assert.deepEqual(parsed[0].travelToNext!.pathSegments, [{ mode: "walk", encodedPolyline: "valid" }]);
  }],
  ["valid but contradictory nested facts are refused, including identity and provider details", async () => {
    const leg = transit("leg-one", "ride-one", 0);
    for (const change of [ { totalMinutes: 11 }, { mode: "walk" }, { fromIndex: 1 }, { legId: "other-leg" },
      { encodedPolyline: "different-route" }, { transit: { ...leg.transit!, departStop: "different-stop" } } ]) {
      const payload = body(leg);
      Object.assign(payload.stops[0].travelToNext!, change);
      await rejected(payload, /travelToNext.*match/);
    }
  }],
  ["an outbound copy cannot invent a leg absent from the top-level topology", async () => {
    await rejected({ ...body(), legs: [] }, /travelToNext.*match/);
  }],
  ["home, skipped rows, and the final timed stop cannot own an inter-stop leg", async () => {
    await rejected({ stops: [skipped, last], legs: [], homeLeg: { ...walk, fromIndex: 0 } }, /homeLeg/);
    await rejected({ ...body(), legs: [{ ...walk, fromIndex: -1 }] }, /consecutive timed stops/);
    await rejected({ ...body(), stops: [stop, { ...skipped, travelToNext: walk }, last] }, /travelToNext.*match/);
    await rejected({ stops: [stop, { ...last, travelToNext: { ...walk, fromIndex: 1 } }], legs: [walk, { ...walk, fromIndex: 1 }] }, /consecutive timed stops/);
    await rejected({ ...body(), legs: [walk, walk] }, /same timed stop/);
  }],
  ["timed indices ignore skipped rows, array order is irrelevant, and missing travel remains valid", async () => {
    const third = { ...last, id: "third", start_time: "2026-07-10T21:20:00-04:00", end_time: "2026-07-10T22:20:00-04:00" };
    const next = { ...walk, fromIndex: 1 };
    const plan = await stored({ stops: [{ ...stop, travelToNext: walk }, skipped,
      { ...last, travelToNext: next }, third], legs: [next, walk], homeLeg: { ...walk, fromIndex: -1 } });
    assert.deepEqual(plan.stops[0].travelToNext, walk);
    assert.equal(plan.stops[1].travelToNext, undefined);
    assert.deepEqual(plan.stops[2].travelToNext, next);
    rebuildLegs(plan);
    assert.deepEqual(plan.legs, [walk, next]);
    assert.equal((await read(plan)).homeLeg!.fromIndex, -1);
    assert.deepEqual((await stored({ stops: [stop, last], legs: [] })).legs, []);
  }],
  ["all-absent legacy identity stays absent through POST, load, rebuild, save, and GET", async () => {
    const legacy = { ...walk, mode: "transit" as const, transit: ride };
    const plan = await stored(body(legacy));
    const before = structuredClone(plan.legs);
    rebuildLegs(plan);
    assert.deepEqual(plan.legs, before);
    await persistRebuild(plan);
    const result = await read(plan);
    assert.deepEqual(result.legs, before);
    assert.deepEqual(result.stops[0].travelToNext, legacy);
    assert.equal(result.legs[0].legId, undefined);
    assert.equal(result.legs[0].transit!.rideId, undefined);
    assert.equal(result.legs[0].transit!.paletteSlot, undefined);
  }],
  ["a missing legacy copy reuses known top-level facts without minting identity", async () => {
    const plan = await stored({ stops: [stop, last], legs: [walk] });
    rebuildLegs(plan);
    assert.deepEqual(plan.legs, [walk]);
    assert.deepEqual(plan.stops[0].travelToNext, walk);
  }],
  ["malformed nested decorations cannot survive creation or reappear after rebuild", async () => {
    const payload = body();
    payload.stops[0].travelToNext!.pathSegments = [ { mode: "walk", encodedPolyline: "" } ];
    const plan = await stored(payload);
    assert.equal(plan.stops[0].travelToNext!.pathSegments, undefined);
    const before = structuredClone(plan.legs);
    rebuildLegs(plan);
    assert.deepEqual(plan.legs, before);
    await persistRebuild(plan);
    await read(plan);
  }],
  ["home-wide decorative conflicts stay sanitized in BOTH representations after rebuild", async () => {
    const home = transit("home", "home-ride", 0, -1);
    const leg = transit("outbound", "outbound-ride", 1);
    leg.pathSegments = [
      // Valid within the outbound leg alone; conflicts with HOME facts only
      // in the combined topology. The stop parser cannot see that conflict.
      { mode: "transit", encodedPolyline: "conflict", rideId: "geometry-ride", sourceStepIndex: 2, paletteSlot: 0 },
      { mode: "transit", encodedPolyline: "kept", rideId: "outbound-ride", sourceStepIndex: 0, paletteSlot: 1 },
    ];
    const plan = await stored({ ...body(leg), homeLeg: home });
    const expected = [leg.pathSegments[1]];
    assert.deepEqual(plan.legs[0].pathSegments, expected);
    assert.deepEqual(plan.stops[0].travelToNext!.pathSegments, expected);
    const before = structuredClone(plan.legs);
    rebuildLegs(plan);
    assert.deepEqual(plan.legs, before);
    await persistRebuild(plan);
    await read(plan);
  }],
  ["home-wide FACT conflicts still reject rather than sanitize", async () => {
    await rejected({ ...body(transit("outbound", "outbound-ride", 0)), homeLeg: transit("home", "home-ride", 0, -1) }, /conflicting transit/);
  }],
];

async function main() {
  let failed = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS  ${name}`); }
    catch (error) { failed++; console.error(`FAIL  ${name}`, error); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed) process.exit(1);
}
void main();
