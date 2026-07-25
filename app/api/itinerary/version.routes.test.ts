import assert from "node:assert";
import { NextRequest } from "next/server";
import { POST as createRoute } from "./route";
import { GET as readRoute } from "./[id]/route";
import { POST as swapRoute } from "./[id]/swap/route";
import { POST as rerouteRoute } from "./[id]/reroute/route";
import { updateItinerary } from "./store";
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

function jsonRequest(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stop = {
  category: "dinner",
  id: "d1",
  name: "Dinner",
  start_time: "2026-07-10T19:00:00-04:00",
  end_time: "2026-07-10T20:00:00-04:00",
  durationMinutes: { base: 50, buffer: 10, total: 60 },
};

const cases: Array<[string, () => Promise<void>]> = [
  [
    "create and read expose the itinerary version and quoted ETag",
    async () => {
      resetRateLimitsForTests();
      const created = await createRoute(
        jsonRequest("http://localhost/api/itinerary", { stops: [stop], legs: [] })
      );
      assert.strictEqual(created.status, 200);
      const createBody = (await created.json()) as { id: string; version: number };
      assert.strictEqual(createBody.version, 1);
      assert.strictEqual(created.headers.get("etag"), '"1"');

      const read = await readRoute(
        new NextRequest(
          `http://localhost/api/itinerary/${createBody.id}?now=${encodeURIComponent(
            "2026-07-10T18:00:00-04:00"
          )}`
        ),
        { params: Promise.resolve({ id: createBody.id }) }
      );
      assert.strictEqual(read.status, 200);
      const itinerary = (await read.json()) as { version: number };
      assert.strictEqual(itinerary.version, 1, "no-op read must not bump version");
      assert.strictEqual(read.headers.get("etag"), '"1"');
    },
  ],
  [
    "failed reroute leaves the persisted version unchanged",
    async () => {
      resetRateLimitsForTests();
      const created = await createRoute(
        jsonRequest("http://localhost/api/itinerary", { stops: [stop], legs: [] })
      );
      const { id, version } = (await created.json()) as {
        id: string;
        version: number;
      };
      const reroute = await rerouteRoute(
        jsonRequest(`http://localhost/api/itinerary/${id}/reroute`, {
          disruption: { type: "transit_cancelled", legIndex: 0 },
          version,
          now: "2026-07-10T18:00:00-04:00",
        }),
        { params: Promise.resolve({ id }) }
      );
      assert.strictEqual(reroute.status, 200);
      const result = (await reroute.json()) as {
        rerouted: boolean;
        version: number;
      };
      assert.strictEqual(result.rerouted, false);
      assert.strictEqual(result.version, version);
      assert.strictEqual(reroute.headers.get("etag"), `"${version}"`);
    },
  ],
  [
    "stale swap and reroute return 409 before any provider work",
    async () => {
      resetRateLimitsForTests();
      const created = await createRoute(
        jsonRequest("http://localhost/api/itinerary", { stops: [stop], legs: [] })
      );
      const { id } = (await created.json()) as { id: string };
      await updateItinerary(id, (proposal) => {
        proposal.stops[0].reason = "newer mutation";
        return { value: null };
      });

      const realFetch = globalThis.fetch;
      let providerCalls = 0;
      globalThis.fetch = (async () => {
        providerCalls++;
        throw new Error("provider must not run");
      }) as typeof fetch;
      try {
        const swap = await swapRoute(
          jsonRequest(`http://localhost/api/itinerary/${id}/swap`, {
            stopIndex: 0,
            refinement: "somewhere cheaper",
            version: 1,
          }),
          { params: Promise.resolve({ id }) }
        );
        assert.strictEqual(swap.status, 409);
        assert.strictEqual((await swap.json()).code, "itinerary_conflict");

        const reroute = await rerouteRoute(
          jsonRequest(`http://localhost/api/itinerary/${id}/reroute`, {
            disruption: { type: "transit_cancelled", legIndex: 0 },
            version: 1,
          }),
          { params: Promise.resolve({ id }) }
        );
        assert.strictEqual(reroute.status, 409);
        assert.strictEqual((await reroute.json()).code, "itinerary_conflict");
        assert.strictEqual(providerCalls, 0);
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
];

(async () => {
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error instanceof Error ? error.stack ?? error.message : error}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
})();
