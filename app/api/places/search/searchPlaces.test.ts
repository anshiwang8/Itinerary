// buildQuery unit tests — constraints must shape the search query.
// Run with: npx tsx app/api/places/search/searchPlaces.test.ts
import assert from "node:assert";
import { buildQuery, GENERAL_QUERIES, includedTypeFor, searchPools } from "./searchPlaces";
import { ParsedPrompt } from "./filter";

function mkParsed(overrides: Partial<ParsedPrompt> = {}): ParsedPrompt {
  return {
    time_window: "unspecified",
    stop_count: null,
    aesthetic: "unspecified",
    category_signals: ["lunch"],
    group_context: "solo",
    budget: null,
    constraints: [],
    location: "Ossington",
    ...overrides,
  };
}

// A repeated category must not cost a second identical Places call — the
// pools are keyed by category, so the duplicate would just overwrite the
// first (code-audit 2026-07-18 §7.1). Slot bookkeeping lives in select.
const searchCases: Array<[string, () => Promise<void>]> = [
  [
    "targetTime (§1.7): a single-slot re-search is filtered at the PLAN's instant",
    async () => {
      // A recovery re-search sends ONE category, so the route used to
      // re-resolve the start time from that category alone — landing on a
      // different instant than the slot it is filling. With targetTime the
      // caller's already-resolved anchor wins.
      process.env.E2E_MOCK = "1";
      const { POST } = await import("./route");
      const body = (targetTime?: string) => ({
        parsed: {
          time_window: "7pm", stop_count: null, aesthetic: "unspecified",
          category_signals: ["dessert"], group_context: "unspecified",
          budget: null, constraints: [], location: "Ossington",
        },
        categoriesOverride: ["dessert"],
        timeZone: "America/Toronto",
        ...(targetTime ? { targetTime } : {}),
      });
      const call = async (targetTime?: string) => {
        const res = await POST(
          new Request("http://localhost/api/places/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body(targetTime)),
          }) as never
        );
        return (await res.json()) as Record<string, Array<{ id: string }>>;
      };
      // Sundown Scoops closes at 21:00. At a 7pm anchor it survives...
      const early = await call();
      const earlyIds = (early.dessert ?? []).map((p) => p.id);
      assert.ok(earlyIds.includes("fx_dessert_sundown"), "expected Sundown at the 7pm anchor");
      // ...and at an explicit 10pm target it must be filtered out, proving
      // the route used the instant it was GIVEN, not one it re-derived.
      const lateTarget = new Date();
      lateTarget.setHours(22, 0, 0, 0);
      const late = await call(lateTarget.toISOString());
      const lateIds = (late.dessert ?? []).map((p) => p.id);
      assert.ok(
        !lateIds.includes("fx_dessert_sundown"),
        `Sundown should be closed at 10pm, got ${JSON.stringify(lateIds)}`
      );
      assert.ok(lateIds.includes("fx_dessert_midnight"), "the late-opening fixture should survive");
      delete process.env.E2E_MOCK;
    },
  ],
  [
    "DUPLICATE CATEGORY: one search per distinct category, pool keyed once",
    async () => {
      const queries: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("places.googleapis.com")) {
          queries.push(JSON.parse(String(init?.body)).textQuery);
          return new Response(JSON.stringify({ places: [{ id: "p1" }, { id: "p2" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        const pools = await searchPools("k", mkParsed({ category_signals: ["bar", "bar"] }));
        assert.strictEqual(queries.length, 1, `expected ONE search, got ${queries.length}`);
        assert.deepStrictEqual(Object.keys(pools), ["bar"]);
        assert.strictEqual(pools.bar.length, 2);
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
];

const cases: Array<[string, () => void]> = [
  [
    "vegan constraint lands in the query",
    () => {
      const q = buildQuery(mkParsed({ constraints: ["vegan"] }), "lunch");
      assert.strictEqual(q, "vegan lunch Ossington Toronto");
    },
  ],
  [
    "constrained and plain queries differ",
    () => {
      const plain = buildQuery(mkParsed(), "lunch");
      const vegan = buildQuery(mkParsed({ constraints: ["vegan"] }), "lunch");
      assert.strictEqual(plain, "lunch Ossington Toronto");
      assert.notStrictEqual(plain, vegan);
      assert.match(vegan, /vegan/);
    },
  ],
  [
    "multiple constraints + aesthetic all present, empty strings dropped",
    () => {
      const q = buildQuery(
        mkParsed({ aesthetic: "quiet", constraints: ["vegan", "", "wheelchair accessible"] }),
        "restaurant"
      );
      assert.strictEqual(q, "quiet vegan wheelchair accessible restaurant Ossington Toronto");
    },
  ],
  [
    "no constraints → query unchanged from the pre-fix shape",
    () => {
      const q = buildQuery(mkParsed({ aesthetic: "lively night out" }), "bar");
      assert.strictEqual(q, "lively night out bar Ossington Toronto");
    },
  ],
  [
    "MULTI-CITY: parsed.city replaces the Toronto literal; absent city keeps it",
    () => {
      // second city flows into the query — never a silent Ossington/Toronto
      const van = buildQuery(mkParsed({ city: "Vancouver", location: "west end" }), "coffee");
      assert.strictEqual(van, "coffee west end Vancouver");
      // pre-multi-city itineraries (no city on parsed) keep the old behavior
      const legacy = buildQuery(mkParsed(), "lunch");
      assert.strictEqual(legacy, "lunch Ossington Toronto");
      // neighbourhood "unspecified" (new parse contract: "" / unspecified) drops out
      const bare = buildQuery(mkParsed({ city: "Montreal", location: "" }), "dinner");
      assert.strictEqual(bare, "dinner Montreal");
    },
  ],
  [
    "park-biased search: green-space categories get includedType 'park'",
    () => {
      // the hard type filter keeps scenic lounges/restaurants out of the pool
      assert.strictEqual(includedTypeFor("park"), "park");
      assert.strictEqual(includedTypeFor("park walk"), "park");
      assert.strictEqual(includedTypeFor("garden"), "park");
      assert.strictEqual(includedTypeFor("quiet trail"), "park");
      // commercial categories stay unfiltered free-text searches
      assert.strictEqual(includedTypeFor("bar"), undefined);
      assert.strictEqual(includedTypeFor("dinner"), undefined);
      assert.strictEqual(includedTypeFor("boardwalk cafe"), undefined); // \bwalk\b — a boardwalk CAFE is commercial
      // the text query itself is unchanged for parks (type filter does the work)
      const q = buildQuery(mkParsed({ aesthetic: "quiet" }), "park");
      assert.strictEqual(q, "quiet park Ossington Toronto");
    },
  ],
  [
    "general pool spans day AND night, and each query is a real located search",
    () => {
      // live evidence: a lone "things to do" query returned 15/20 daytime
      // attractions (all closed at 11 PM) leaving parks only — no bar, no
      // live music, no late food ever entered the running
      assert.ok(GENERAL_QUERIES.includes("things to do"), "daytime attractions still covered");
      for (const q of ["bar", "live music", "late night food", "entertainment"]) {
        assert.ok(GENERAL_QUERIES.includes(q), `general pool must cover "${q}"`);
      }
      // every general query builds a properly located query (city + hood)
      for (const q of GENERAL_QUERIES) {
        assert.strictEqual(buildQuery(mkParsed(), q), `${q} Ossington Toronto`);
      }
      // and they still respect an aesthetic/constraints like any category
      assert.strictEqual(
        buildQuery(mkParsed({ aesthetic: "lively" }), "bar"),
        "lively bar Ossington Toronto"
      );
    },
  ],
  [
    "casino-biased search: casino categories get includedType 'casino'",
    () => {
      // live evidence: the text query "casino Toronto" returns poker clubs,
      // arcade bars, and jazz lounges rated HIGHER than the real casinos —
      // the hard type filter keeps the pool to genuine casino-type places
      assert.strictEqual(includedTypeFor("casino"), "casino");
      assert.strictEqual(includedTypeFor("casinos"), "casino");
      assert.strictEqual(includedTypeFor("casino night"), "casino");
      // nightlife lookalikes stay unfiltered free-text searches
      assert.strictEqual(includedTypeFor("nightclub"), undefined);
      assert.strictEqual(includedTypeFor("club"), undefined);
      assert.strictEqual(includedTypeFor("poker club"), undefined);
      // the text query itself is unchanged (type filter does the work)
      assert.strictEqual(buildQuery(mkParsed(), "casino"), "casino Ossington Toronto");
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
  for (const [name, fn] of searchCases) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${err instanceof Error ? err.message : err}`);
    }
  }
  const total = cases.length + searchCases.length;
  console.log(`\n${total - failed}/${total} passed`);
  if (failed > 0) process.exit(1);
})();
