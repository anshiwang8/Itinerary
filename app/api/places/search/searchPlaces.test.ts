// buildQuery unit tests — constraints must shape the search query.
// Run with: npx tsx app/api/places/search/searchPlaces.test.ts
import assert from "node:assert";
import {
  buildQuery,
  GENERAL_QUERIES,
  includedTypeFor,
  MAX_PROVIDER_CALLS_PER_SEARCH,
  SEARCH_FIELD_GROUPS,
  SEARCH_FIELD_MASK,
  SEARCH_FIELD_MASK_FIELDS,
  searchPools,
} from "./searchPlaces";
import { DropEntry, ParsedPrompt } from "./filter";
import { isOutdoorCategory } from "../../../lib/categoryTraits";
import { resolveCategory } from "../../schedule/durations";
import { isPlausibleAt } from "../../schedule/schedule";

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
    "M17 FIELD MASK + CALL BASELINE: one complete search call preserves every required fact",
    async () => {
      let calls = 0;
      let sentMask = "";
      const completePlace = {
        id: "complete",
        displayName: { text: "Complete Place" },
        location: { latitude: 43.65, longitude: -79.4 },
        rating: 4.6,
        priceLevel: "PRICE_LEVEL_MODERATE",
        currentOpeningHours: {
          periods: [
            {
              open: { day: 1, hour: 9, minute: 0 },
              close: { day: 1, hour: 21, minute: 0 },
            },
          ],
        },
        businessStatus: "OPERATIONAL",
        editorialSummary: { text: "The description rendered on the stop card." },
        servesVegetarianFood: true,
        outdoorSeating: true,
        liveMusic: true,
        goodForChildren: true,
        allowsDogs: true,
        accessibilityOptions: {
          wheelchairAccessibleEntrance: true,
        },
      };
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("places.googleapis.com")) {
          calls++;
          sentMask = new Headers(init?.headers).get("X-Goog-FieldMask") ?? "";
          return new Response(JSON.stringify({ places: [completePlace] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        const pools = await searchPools("k", mkParsed());
        assert.strictEqual(
          calls,
          1,
          "ordinary discovery remains one complete provider call, not discovery plus enrichment"
        );
        assert.strictEqual(sentMask, SEARCH_FIELD_MASK);
        assert.deepStrictEqual(pools.lunch, [completePlace]);
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "M17 REQUEST-SCOPE DEDUPE: overlapping late-night variants cost only two unique calls",
    async () => {
      const queries: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("places.googleapis.com")) {
          const query = JSON.parse(String(init?.body)).textQuery as string;
          queries.push(query);
          return new Response(
            JSON.stringify({ places: [{ id: `p${queries.length}` }] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        await searchPools(
          "k",
          mkParsed({ category_signals: ["bar", "late night bar"] }),
          undefined,
          undefined,
          { lateNight: true }
        );
        assert.deepStrictEqual(queries, [
          "bar Ossington Toronto",
          "late night bar Ossington Toronto",
        ]);
        assert.strictEqual(
          queries.filter((query) => query === "late night bar Ossington Toronto").length,
          1,
          "the query shared by both category variants must reach Places once"
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "M17 FRESHNESS: identical later attempts refetch opening hours instead of caching Places content",
    async () => {
      let calls = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("places.googleapis.com")) {
          calls++;
          return new Response(
            JSON.stringify({
              places: [
                {
                  id: "fresh-hours",
                  currentOpeningHours: {
                    periods: [
                      {
                        open: { day: 1, hour: calls === 1 ? 9 : 10, minute: 0 },
                        close: { day: 1, hour: 22, minute: 0 },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        const first = await searchPools("k", mkParsed());
        const second = await searchPools("k", mkParsed());
        assert.strictEqual(calls, 2, "full Places payloads must not cross request boundaries");
        assert.strictEqual(
          first.lunch[0].currentOpeningHours?.periods?.[0]?.open?.hour,
          9
        );
        assert.strictEqual(
          second.lunch[0].currentOpeningHours?.periods?.[0]?.open?.hour,
          10
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "M17 ISOLATION: city, category, and late-night mode produce independent provider work",
    async () => {
      const queries: string[] = [];
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
      try {
        await searchPools("k", mkParsed({ city: "Toronto", category_signals: ["lunch"] }));
        await searchPools("k", mkParsed({ city: "Vancouver", category_signals: ["lunch"] }));
        await searchPools("k", mkParsed({ city: "Toronto", category_signals: ["dinner"] }));
        await searchPools(
          "k",
          mkParsed({ city: "Toronto", category_signals: ["lunch"] }),
          undefined,
          undefined,
          { lateNight: true }
        );
        assert.deepStrictEqual(queries, [
          "lunch Ossington Toronto",
          "lunch Ossington Vancouver",
          "dinner Ossington Toronto",
          "lunch Ossington Toronto",
          "late night lunch Ossington Toronto",
        ]);
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "M17 FAILURE POLICY: a failed search is not cached into the next attempt",
    async () => {
      let calls = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("places.googleapis.com")) {
          calls++;
          return calls === 1
            ? new Response(JSON.stringify({ error: { message: "temporary" } }), {
                status: 503,
                headers: { "Content-Type": "application/json" },
              })
            : new Response(JSON.stringify({ places: [{ id: "recovered" }] }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        await assert.rejects(() => searchPools("k", mkParsed()), /places_rejected_request/);
        const recovered = await searchPools("k", mkParsed());
        assert.strictEqual(calls, 2);
        assert.deepStrictEqual(recovered.lunch.map((place) => place.id), ["recovered"]);
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "M17 CALL CEILING: eight categories cost at most 8 daytime or 16 late-night calls",
    async () => {
      let calls = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("places.googleapis.com")) {
          calls++;
          return new Response(JSON.stringify({ places: [{ id: `p${calls}` }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        const categories = Array.from({ length: 8 }, (_, index) => `category-${index + 1}`);
        await searchPools("k", mkParsed({ category_signals: categories }));
        assert.strictEqual(calls, 8);

        calls = 0;
        await searchPools(
          "k",
          mkParsed({ category_signals: categories }),
          undefined,
          undefined,
          { lateNight: true }
        );
        assert.strictEqual(MAX_PROVIDER_CALLS_PER_SEARCH, 16);
        assert.strictEqual(calls, 16);

        calls = 0;
        await searchPools("k", mkParsed({ category_signals: [] }));
        assert.strictEqual(calls, 5, "the general pool stays at its five-query bound");

        calls = 0;
        await assert.rejects(
          () =>
            searchPools(
              "k",
              mkParsed({
                category_signals: [...categories, "category-9"],
              })
            ),
          (error: unknown) =>
            error instanceof Error &&
            "publicMessage" in error &&
            String(error.publicMessage).includes("at most 8 distinct categories")
        );
        assert.strictEqual(calls, 0, "the bound is enforced before upstream work");
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
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
    "§6.1: ONE category's search failure doesn't discard the others",
    async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("places.googleapis.com")) {
          const q = JSON.parse(String(init?.body)).textQuery as string;
          // the "bar" search rate-limits; dinner is fine
          if (q.includes("bar")) {
            return new Response(JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED" } }), {
              status: 429,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ places: [{ id: "ok1" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        const out = { failures: [] as DropEntry[] };
        // pre-fix this threw and the whole request 500'd
        const pools = await searchPools(
          "k",
          mkParsed({ category_signals: ["dinner", "bar"] }),
          undefined,
          out
        );
        assert.deepStrictEqual(pools.dinner.map((p) => p.id), ["ok1"], "good category survives");
        assert.deepStrictEqual(pools.bar, [], "failed category becomes an EMPTY pool");
        assert.strictEqual(out.failures.length, 1);
        assert.strictEqual(out.failures[0].category, "bar");
        assert.strictEqual(out.failures[0].rule, "searchFailed");
        assert.strictEqual(
          out.failures[0].detail,
          "The venue search provider was unavailable for this category."
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "§6.1: only a TOTAL wipeout still throws",
    async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("places.googleapis.com")) {
          return new Response(JSON.stringify({ error: { message: "boom" } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        await assert.rejects(
          () => searchPools("k", mkParsed({ category_signals: ["dinner", "bar"] })),
          /places_rejected_request/
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "LATE NIGHT: a named category unions its 'late night' variant; daytime stays one query",
    async () => {
      // probe evidence (Toronto, 23:30): plain "restaurant" returned 6/20
      // open — dominated by well-known, by-then-closed venues, the same
      // class of skew GENERAL_QUERIES fixed for the vague pool
      const queries: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("places.googleapis.com")) {
          const q = JSON.parse(String(init?.body)).textQuery as string;
          queries.push(q);
          // overlap on lp1 proves the union dedupes; the primary query wins
          const places = q.includes("late night")
            ? [{ id: "lp1" }, { id: "late_only" }]
            : [{ id: "lp1" }, { id: "day_only" }];
          return new Response(JSON.stringify({ places }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        const pools = await searchPools(
          "k",
          mkParsed({ category_signals: ["restaurant"] }),
          undefined,
          undefined,
          { lateNight: true }
        );
        assert.deepStrictEqual(queries, [
          "restaurant Ossington Toronto",
          "late night restaurant Ossington Toronto",
        ]);
        assert.deepStrictEqual(
          pools.restaurant.map((p) => p.id),
          ["lp1", "day_only", "late_only"],
          "union of both queries, deduped, primary first"
        );

        // daytime: exactly one query, byte-identical to the old behaviour
        queries.length = 0;
        const day = await searchPools("k", mkParsed({ category_signals: ["restaurant"] }));
        assert.deepStrictEqual(queries, ["restaurant Ossington Toronto"]);
        assert.deepStrictEqual(day.restaurant.map((p) => p.id), ["lp1", "day_only"]);
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "LATE NIGHT: one failed sibling query preserves the successful candidates",
    async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("places.googleapis.com")) {
          const query = JSON.parse(String(init?.body)).textQuery as string;
          if (query.includes("late night")) {
            return new Response(JSON.stringify({ error: { message: "temporary" } }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ places: [{ id: "primary_survives" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      try {
        const pools = await searchPools(
          "k",
          mkParsed({ category_signals: ["restaurant"] }),
          undefined,
          undefined,
          { lateNight: true }
        );
        assert.deepStrictEqual(
          pools.restaurant.map((place) => place.id),
          ["primary_survives"]
        );
      } finally {
        globalThis.fetch = realFetch;
      }
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
    "M17 FIELD MASK CONTRACT: every high-cost field has an explicit correctness consumer",
    () => {
      assert.deepStrictEqual(SEARCH_FIELD_GROUPS, {
        identityAndRouting: [
          "places.displayName",
          "places.id",
          "places.location",
        ],
        objectiveFilter: [
          "places.rating",
          "places.priceLevel",
          "places.currentOpeningHours",
          "places.businessStatus",
        ],
        productOutput: ["places.editorialSummary"],
        structuredConstraintEvidence: [
          "places.servesVegetarianFood",
          "places.outdoorSeating",
          "places.liveMusic",
          "places.goodForChildren",
          "places.allowsDogs",
          "places.accessibilityOptions",
        ],
      });
      assert.strictEqual(
        new Set(SEARCH_FIELD_MASK_FIELDS).size,
        SEARCH_FIELD_MASK_FIELDS.length,
        "field mask must not contain duplicate billable fields"
      );
      assert.strictEqual(
        SEARCH_FIELD_MASK,
        [
          "places.displayName",
          "places.id",
          "places.location",
          "places.rating",
          "places.priceLevel",
          "places.currentOpeningHours",
          "places.businessStatus",
          "places.editorialSummary",
          "places.servesVegetarianFood",
          "places.outdoorSeating",
          "places.liveMusic",
          "places.goodForChildren",
          "places.allowsDogs",
          "places.accessibilityOptions",
        ].join(",")
      );
    },
  ],
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
    "§5.3: one traits table — park treatment is coherent across the pipeline",
    () => {
      // membership the four old regexes disagreed on:
      // "bench" was park-filtered in SEARCH but never weather-gated
      assert.strictEqual(includedTypeFor("bench"), "park");
      assert.strictEqual(isOutdoorCategory("bench"), true);
      assert.strictEqual(resolveCategory("bench"), "park");
      assert.ok(isPlausibleAt(new Date(2026, 6, 3, 10, 0), ["bench"]));
      assert.ok(!isPlausibleAt(new Date(2026, 6, 3, 23, 30), ["bench"]));
      // "green space" likewise
      assert.strictEqual(includedTypeFor("green space"), "park");
      assert.strictEqual(isOutdoorCategory("green space"), true);
      assert.strictEqual(resolveCategory("green space"), "park");
      // "patio" is weather-exposed but NOT green space — it must NOT get
      // the park type filter, the park duration, or the park band
      assert.strictEqual(isOutdoorCategory("patio"), true);
      assert.strictEqual(includedTypeFor("patio"), undefined);
      assert.notStrictEqual(resolveCategory("patio"), "park");
      // and the walk boundary still holds: a boardwalk cafe is a cafe
      assert.strictEqual(includedTypeFor("boardwalk cafe"), undefined);
      assert.strictEqual(resolveCategory("boardwalk cafe"), "coffee shop");
      assert.strictEqual(isOutdoorCategory("boardwalk cafe"), false);
      // the ordinary park case is unchanged on every axis
      assert.strictEqual(includedTypeFor("park walk"), "park");
      assert.strictEqual(isOutdoorCategory("park walk"), true);
      assert.strictEqual(resolveCategory("park walk"), "park");
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
