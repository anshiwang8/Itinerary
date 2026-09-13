// /api/places/search route-level tests for per-activity location threading —
// the compound-location fix's end-to-end proof: a request naming a plannedLocation
// per activity must have EACH category searched around its OWN neighbourhood,
// never the whole plan's flat parsed.location. searchPools/buildQuery's own
// unit coverage lives in searchPlaces.test.ts; this file proves the ROUTE
// correctly parses `plannedLocations` and builds the per-category map from it.
// Run with: npx tsx app/api/places/search/route.test.ts
import assert from "node:assert";
import { POST } from "./route";
import { ParsedPrompt } from "./filter";

process.env.GOOGLE_PLACES_API_KEY = "test-key";

const parsed: ParsedPrompt = {
  time_window: "evening",
  stop_count: null,
  aesthetic: "unspecified",
  category_signals: ["italian restaurant", "live music venue"],
  group_context: "solo",
  budget: null,
  constraints: [],
  location: "Ossington",
};

function req(body: unknown) {
  return new Request("http://localhost/api/places/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function stubPlaces(queries: string[]) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("places.googleapis.com")) {
      const query = JSON.parse(String(init?.body)).textQuery as string;
      queries.push(query);
      return new Response(JSON.stringify({ places: [{ id: `p${queries.length}` }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(url as never, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

const cases: Array<[string, () => Promise<void>]> = [
  [
    "COMPOUND-LOCATION FIX: 'dinner in the Distillery District, then live music on Ossington' searches each category in its OWN neighbourhood",
    async () => {
      const queries: string[] = [];
      const restore = stubPlaces(queries);
      try {
        const res = await POST(
          req({
            parsed,
            plannedLocations: ["the Distillery District", "Ossington"],
          })
        );
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(queries, [
          "italian restaurant the Distillery District Toronto",
          "live music venue Ossington Toronto",
        ]);
      } finally {
        restore();
      }
    },
  ],
  [
    "a legacy/older-shaped request with no plannedLocations at all falls back to the flat parsed.location for every category — byte-identical to today",
    async () => {
      const queries: string[] = [];
      const restore = stubPlaces(queries);
      try {
        const res = await POST(req({ parsed }));
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(queries, [
          "italian restaurant Ossington Toronto",
          "live music venue Ossington Toronto",
        ]);
      } finally {
        restore();
      }
    },
  ],
  [
    "an activity with an empty plannedLocation entry falls back to parsed.location, unaffected by a sibling's override",
    async () => {
      const queries: string[] = [];
      const restore = stubPlaces(queries);
      try {
        const res = await POST(
          req({ parsed, plannedLocations: ["", "Ossington"] })
        );
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(queries, [
          "italian restaurant Ossington Toronto",
          "live music venue Ossington Toronto",
        ]);
      } finally {
        restore();
      }
    },
  ],
  [
    "a mismatched plannedLocations length is rejected at the boundary, before any provider call",
    async () => {
      const queries: string[] = [];
      const restore = stubPlaces(queries);
      try {
        const res = await POST(
          req({ parsed, plannedLocations: ["only one"] })
        );
        assert.strictEqual(res.status, 400);
        assert.strictEqual(queries.length, 0);
      } finally {
        restore();
      }
    },
  ],
  [
    "the SAME-CATEGORY, different-neighbourhood case still collapses onto one pool/location — documented limitation, unchanged by this fix",
    async () => {
      const queries: string[] = [];
      const restore = stubPlaces(queries);
      try {
        const res = await POST(
          req({
            parsed: { ...parsed, category_signals: ["bar", "bar"] },
            plannedLocations: ["Kensington", "the Distillery District"],
          })
        );
        assert.strictEqual(res.status, 200);
        // one distinct category → one search, one location (whichever the
        // map ends up keeping) — never two separate bar searches
        assert.strictEqual(queries.length, 1);
      } finally {
        restore();
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
  if (failed > 0) {
    console.log(`\n${failed} of ${cases.length} cases failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${cases.length} cases passed.`);
})();
