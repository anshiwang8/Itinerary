// Tests for the persistence seam: loadItinerary/saveItinerary go through
// the Redis REST API when KV env vars are set, collapse to the in-memory
// Map when they aren't, and refuse loudly on serverless without KV.
// Redis is stubbed via globalThis.fetch (same pattern as the Groq stubs).
// Run with: npx tsx app/api/itinerary/store.kv.test.ts
import assert from "node:assert";
import { createItinerary, kvConfigured, loadItinerary, saveItinerary } from "./store";
import { ScheduledStop } from "../schedule/schedule";

// ── Redis REST stub: records commands, serves a tiny key-value map ──
const kvData = new Map<string, string>();
let commands: unknown[][] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (String(url).includes("fake-kv.example")) {
    const cmd = JSON.parse(String(init?.body)) as unknown[];
    commands.push(cmd as unknown[][number][]);
    const [op, key, value] = cmd as [string, string, string?];
    if (op === "SET") {
      kvData.set(key, value!);
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }
    if (op === "GET") {
      return new Response(JSON.stringify({ result: kvData.get(key) ?? null }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: `unhandled ${op}` }), { status: 400 });
  }
  return realFetch(url as never, init);
}) as typeof fetch;

function mkStops(): ScheduledStop[] {
  return [
    {
      category: "dinner",
      id: "v1",
      name: "Venue One",
      start_time: "2026-07-10T19:00:00-04:00",
      end_time: "2026-07-10T20:45:00-04:00",
      durationMinutes: { base: 90, buffer: 15, total: 105 },
      priceLevel: "PRICE_LEVEL_MODERATE",
      description: "A test venue.",
    },
  ];
}

function setKvEnv(on: boolean) {
  if (on) {
    process.env.KV_REST_API_URL = "https://fake-kv.example";
    process.env.KV_REST_API_TOKEN = "test-token";
  } else {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
}

const cases: Array<[string, () => Promise<void>]> = [
  [
    "memory mode (no KV env): save + load work off the Map, no fetch",
    async () => {
      setKvEnv(false);
      commands = [];
      assert.strictEqual(kvConfigured(), false);
      const it = createItinerary(mkStops(), []);
      await saveItinerary(it);
      const back = await loadItinerary(it.id);
      assert.strictEqual(back, it); // same object — the Map, not a copy
      assert.strictEqual(commands.length, 0, "no Redis traffic in memory mode");
    },
  ],
  [
    "KV mode: save issues SET with itin: key, JSON body, and a TTL",
    async () => {
      setKvEnv(true);
      commands = [];
      const it = createItinerary(mkStops(), []);
      await saveItinerary(it);
      assert.strictEqual(commands.length, 1);
      const [op, key, value, ex, ttl] = commands[0] as [string, string, string, string, number];
      assert.strictEqual(op, "SET");
      assert.strictEqual(key, `itin:${it.id}`);
      assert.deepStrictEqual(JSON.parse(value).stops[0].name, "Venue One");
      assert.strictEqual(ex, "EX");
      assert.ok(typeof ttl === "number" && ttl > 0, "TTL set — demo data expires");
    },
  ],
  [
    "KV mode: load round-trips the full itinerary through Redis, not memory",
    async () => {
      setKvEnv(true);
      const it = createItinerary(mkStops(), []);
      await saveItinerary(it);
      commands = [];
      const back = await loadItinerary(it.id);
      assert.strictEqual(commands.length, 1, "load must hit Redis (memory can be stale)");
      assert.deepStrictEqual(commands[0], ["GET", `itin:${it.id}`]);
      assert.notStrictEqual(back, it); // a deserialized copy, not the Map object
      assert.deepStrictEqual(back, JSON.parse(JSON.stringify(it)));
      // the fields the strip depends on survive serialization
      assert.strictEqual(back!.stops[0].priceLevel, "PRICE_LEVEL_MODERATE");
      assert.strictEqual(back!.stops[0].description, "A test venue.");
    },
  ],
  [
    "KV mode: unknown id → undefined (the route's honest 404)",
    async () => {
      setKvEnv(true);
      assert.strictEqual(await loadItinerary("nope"), undefined);
    },
  ],
  [
    "serverless without KV: load/save refuse loudly instead of silent 404s",
    async () => {
      setKvEnv(false);
      process.env.VERCEL = "1";
      try {
        await assert.rejects(() => saveItinerary(createItinerary(mkStops(), [])), /persistent store/i);
        await assert.rejects(() => loadItinerary("x"), /persistent store/i);
      } finally {
        delete process.env.VERCEL;
      }
    },
  ],
];

// ── runner ──
(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${err instanceof Error ? err.message : err}`);
    }
  }
  setKvEnv(false);
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
})();
