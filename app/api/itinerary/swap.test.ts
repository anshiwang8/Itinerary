// Per-stop swap engine tests — surgical replacement, held slot, floor_time
// protection. Pipeline deps are injected fakes; no network.
// Run with: npx tsx app/api/itinerary/swap.test.ts
import assert from "node:assert";
import { createItinerary, withStatuses } from "./store";
import { swapStop, SwapDeps } from "./swap";
import { Place } from "../places/search/filter";
import { ScheduledStop } from "../schedule/schedule";
import { TravelLeg } from "../schedule/travel";

const T = (h: number, m: number) =>
  `2026-07-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`;
const ms = (iso: string | null) => new Date(iso!).getTime();

function leg(fromIndex: number, mode: "transit" | "walk", total: number): TravelLeg {
  return {
    fromIndex, mode,
    rawMinutes: mode === "transit" ? total - 5 : total,
    marginMinutes: mode === "transit" ? 5 : 0,
    totalMinutes: total, distanceMeters: 1000, encodedPolyline: "enc_old",
  };
}

// dinner 19:00–20:45 (105) → bar 21:00–22:10 (70) → dessert 22:20–23:00 (40)
function mkStops(): ScheduledStop[] {
  return [
    {
      category: "dinner", id: "d1", name: "Dinner Spot",
      start_time: T(19, 0), end_time: T(20, 45),
      durationMinutes: { base: 90, buffer: 15, total: 105 },
      location: { latitude: 43.647, longitude: -79.42 },
      travelMinutesToNext: 15, travelToNext: leg(0, "transit", 15),
    },
    {
      category: "bar", id: "b1", name: "Bar Spot",
      start_time: T(21, 0), end_time: T(22, 10),
      durationMinutes: { base: 60, buffer: 10, total: 70 },
      location: { latitude: 43.649, longitude: -79.41 },
      travelMinutesToNext: 10, travelToNext: leg(1, "walk", 10),
    },
    {
      category: "dessert", id: "s1", name: "Dessert Spot",
      start_time: T(22, 20), end_time: T(23, 0),
      durationMinutes: { base: 30, buffer: 10, total: 40 },
      location: { latitude: 43.65, longitude: -79.405 },
    },
  ];
}

function mkItinerary() {
  return createItinerary(mkStops(), [leg(0, "transit", 15), leg(1, "walk", 10)], {
    time_window: "evening", stop_count: null, aesthetic: "lively",
    category_signals: ["dinner", "bar", "dessert"], group_context: "date",
    budget: null, constraints: [], location: "Ossington",
  });
}

function mkVenue(id: string, name = `New ${id}`): Place {
  return {
    id, displayName: { text: name }, rating: 4.5, businessStatus: "OPERATIONAL",
    location: { latitude: 43.651, longitude: -79.415 },
  };
}

interface Opts {
  intent?: "venue" | "time" | "constraint";
  newStartClock?: string;
  path?: "refilter" | "research";
  newCategory?: string;
  budget?: string | null;
  constraints?: string[];
  pool?: Place[];
  legMin?: number;
  onSearch?: (parsed: { constraints: string[]; category_signals: string[]; budget: string | null }) => void;
  onSelect?: (pools: Record<string, Place[]>) => void;
}

function mkDeps(opts: Opts = {}): SwapDeps {
  return {
    interpret: async (parsed, category, _currentStartISO, refinement) => {
      const intent =
        opts.intent ??
        (/too late|earlier|later|after \d|at \d/i.test(refinement)
          ? "time"
          : /patio|outdoor|near/i.test(refinement)
          ? "constraint"
          : "venue");
      const path =
        intent === "constraint"
          ? "research"
          : opts.path ?? (/patio|outdoor|cuisine/i.test(refinement) ? "research" : "refilter");
      return {
        intent,
        path,
        category: opts.newCategory ?? category,
        aesthetic: parsed.aesthetic,
        budget:
          opts.budget !== undefined
            ? opts.budget
            : /cheap|cheaper|budget/i.test(refinement)
            ? "cheap"
            : parsed.budget,
        constraints: opts.constraints ?? (/patio/i.test(refinement) ? ["patio"] : parsed.constraints),
        newStartClock: opts.newStartClock ?? null,
      };
    },
    searchPools: async (parsed, cats) => {
      opts.onSearch?.(parsed as never);
      const key = cats[0];
      return { [key]: opts.pool ?? [mkVenue(`${key}_fresh`)] };
    },
    selectVenues: async (_parsed, pools) => {
      opts.onSelect?.(pools);
      return Object.entries(pools).map(([category, arr]) =>
        arr.length
          ? { category, id: arr[0].id, reason: `A fresh ${category} that fits.`, name: arr[0].displayName?.text, rating: arr[0].rating }
          : { category, id: null, reason: "no venues survived filtering" }
      );
    },
    getSingleLeg: async (_o, _d, fromIndex, _dep, _ex) => ({
      fromIndex, mode: "walk", rawMinutes: opts.legMin ?? 10, marginMinutes: 0,
      totalMinutes: opts.legMin ?? 10, distanceMeters: 700, encodedPolyline: "enc_new",
    }),
  };
}

const cases: Array<[string, () => Promise<void>]> = [
  [
    "upcoming swap that fits holds the slot; nothing downstream moves",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0)); // all upcoming
      // refilter "cheaper", same category/duration (bar 70), 10-min outbound
      const res = await swapStop(it, 1, "somewhere cheaper", now, mkDeps({ legMin: 10 }));
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "refilter");
      assert.strictEqual(res.downstreamShifted.length, 0);
      // new venue, held slot
      assert.strictEqual(it.stops[1].name, "New bar_fresh");
      assert.notStrictEqual(it.stops[1].id, "b1");
      assert.strictEqual(it.stops[1].start_time, T(21, 0));
      assert.strictEqual(it.stops[1].end_time, T(22, 10));
      // dessert untouched
      assert.strictEqual(it.stops[2].start_time, T(22, 20));
      assert.strictEqual(it.stops[2].end_time, T(23, 0));
      // dinner untouched
      assert.strictEqual(it.stops[0].id, "d1");
    },
  ],
  [
    "swap whose new pick runs longer shifts downstream; locked dinner never touched",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(19, 30)); // mid-dinner: dinner active + locked
      withStatuses(it, now);
      assert.strictEqual(it.stops[0].locked, true);
      // research → restaurant (105 min) in the bar slot; ends 22:45
      const res = await swapStop(
        it, 1, "something more substantial with a different cuisine", now,
        mkDeps({ path: "research", newCategory: "restaurant", legMin: 10 })
      );
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "research");
      assert.strictEqual(it.stops[1].category, "restaurant");
      assert.strictEqual(it.stops[1].start_time, T(21, 0)); // slot held
      assert.strictEqual(it.stops[1].end_time, T(22, 45)); // 21:00 + 105
      // required next = 22:45 + 10 = 22:55 > dessert's 22:20 → delta 35
      assert.deepStrictEqual(res.downstreamShifted, [2]);
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(22, 55)));
      assert.strictEqual(ms(it.stops[2].end_time), ms(T(23, 35)));
      // floor guarantee: locked dinner (before the swap) is byte-identical
      assert.strictEqual(it.stops[0].start_time, T(19, 0));
      assert.strictEqual(it.stops[0].end_time, T(20, 45));
      assert.strictEqual(it.stops[0].name, "Dinner Spot");
      assert.strictEqual(it.stops[0].locked, true);
    },
  ],
  [
    "the rejected venue is never a candidate and never re-picked",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      let sawExcluded = true;
      const res = await swapStop(
        it, 1, "not feeling this bar", now,
        mkDeps({
          // pool still contains the rejected b1 plus a fresh option
          pool: [mkVenue("b1", "Bar Spot"), mkVenue("b_new", "New Bar")],
          onSelect: (pools) => {
            sawExcluded = Object.values(pools).flat().some((p) => p.id === "b1");
          },
        })
      );
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(sawExcluded, false, "rejected id must be filtered before select");
      assert.strictEqual(it.stops[1].id, "b_new");
      assert.notStrictEqual(it.stops[1].id, "b1");
    },
  ],
  [
    "refilter vs research: path classified, and only research widens the query",
    async () => {
      // refilter — search keeps the original (empty) constraints
      const it1 = mkItinerary();
      let refilterSearch: string[] | null = null;
      const r1 = await swapStop(
        it1, 1, "somewhere cheaper", new Date(T(18, 0)),
        mkDeps({ onSearch: (p) => (refilterSearch = p.constraints) })
      );
      assert.ok(r1.swapped && r1.path === "refilter");
      assert.deepStrictEqual(refilterSearch, []); // original pool, unchanged query

      // research — the new constraint reaches the search query
      const it2 = mkItinerary();
      let researchSearch: string[] | null = null;
      const r2 = await swapStop(
        it2, 1, "somewhere with a patio", new Date(T(18, 0)),
        mkDeps({ onSearch: (p) => (researchSearch = p.constraints) })
      );
      assert.ok(r2.swapped && r2.path === "research");
      assert.ok((researchSearch as unknown as string[]).includes("patio"));
    },
  ],
  [
    "active or past stops are rejected with a clear message",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(21, 30)); // dinner done, bar active, dessert upcoming
      // active bar
      const rBar = await swapStop(it, 1, "somewhere cheaper", now, mkDeps());
      assert.strictEqual(rBar.swapped, false);
      if (!rBar.swapped) assert.match(rBar.reason, /upcoming/i);
      // completed dinner
      const rDinner = await swapStop(it, 0, "somewhere cheaper", now, mkDeps());
      assert.strictEqual(rDinner.swapped, false);
      // both untouched
      assert.strictEqual(it.stops[0].id, "d1");
      assert.strictEqual(it.stops[1].id, "b1");
    },
  ],
  [
    "TIME complaint ('too late') moves the stop earlier and re-checks venues",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0)); // all upcoming
      let searched: string[] | null = null;
      // move dinner 19:00 → 18:30 (earlier)
      const res = await swapStop(
        it, 0, "the time is too late", now,
        mkDeps({ intent: "time", newStartClock: "18:30", legMin: 10, onSearch: (p) => (searched = p.category_signals) })
      );
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "time");
      // slot MOVED, not just the venue
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(18, 30)));
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(20, 15))); // 18:30 + 105
      // venues were re-checked at the new time (search ran for dinner)
      assert.deepStrictEqual(searched, ["dinner"]);
      // moving earlier doesn't push anything downstream
      assert.deepStrictEqual(res.downstreamShifted, []);
      assert.strictEqual(it.stops[1].start_time, T(21, 0)); // bar unchanged
    },
  ],
  [
    "impossible time ('dinner at 4am') fails loud with the real reason",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      const res = await swapStop(
        it, 0, "can we do dinner at 4am", now,
        mkDeps({ intent: "time", newStartClock: "04:00" })
      );
      assert.strictEqual(res.swapped, false);
      // specific reason (not a generic "keeping it"), names the hour
      if (!res.swapped) assert.match(res.reason, /4:00 AM|won't work|nothing's really open/);
      // dinner untouched
      assert.strictEqual(it.stops[0].id, "d1");
      assert.strictEqual(it.stops[0].start_time, T(19, 0));
    },
  ],
  [
    "no better candidate → honest refusal, original kept",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      // pool holds only the rejected venue → nothing survives exclusion
      const res = await swapStop(
        it, 1, "somewhere cheaper", now,
        mkDeps({ pool: [mkVenue("b1", "Bar Spot")] })
      );
      assert.strictEqual(res.swapped, false);
      if (!res.swapped) assert.match(res.reason, /Couldn't find another bar that fits — keeping Bar Spot/);
      // original bar untouched
      assert.strictEqual(it.stops[1].id, "b1");
      assert.strictEqual(it.stops[1].start_time, T(21, 0));
      assert.strictEqual(it.stops[1].end_time, T(22, 10));
    },
  ],
];

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
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
})();
