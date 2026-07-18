// Per-stop swap engine tests — surgical replacement, held slot, floor_time
// protection. Pipeline deps are injected fakes; no network.
// Run with: npx tsx app/api/itinerary/swap.test.ts
import assert from "node:assert";
import { createItinerary, withStatuses } from "./store";
import {
  swapStop,
  SwapDeps,
  interpretRefinement,
  parseTimeExpr,
  parseDurationExpr,
  usableByHours,
  TimeShift,
  DurationShift,
} from "./swap";
import { Place, WeatherHour } from "../places/search/filter";
import { ScheduledStop } from "../schedule/schedule";
import { TravelLeg } from "../schedule/travel";

const T = (h: number, m: number) =>
  `2026-07-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`;
// Vancouver wall-clock (PDT, −07:00) for the same calendar day — used by the
// multi-city zone tests. T(h,m) and V(h,m) are 3h apart as instants.
const V = (h: number, m: number) =>
  `2026-07-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-07:00`;
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
    // the factual Places editorial — swap-produced stops must carry it as
    // `description`, distinct from the pick-justification `reason`
    editorialSummary: { text: `${name}, a real spot on the strip.` },
  };
}

interface Opts {
  intent?: "venue" | "time" | "constraint" | "duration";
  time?: TimeShift;
  duration?: DurationShift;
  path?: "refilter" | "research";
  newCategory?: string;
  budget?: string | null;
  constraints?: string[];
  pool?: Place[];
  legMin?: number;
  /** ids treated as closed by the availability seam (forces adapt) */
  unusableIds?: string[];
  onSearch?: (parsed: { constraints: string[]; category_signals: string[]; budget: string | null }) => void;
  onSelect?: (pools: Record<string, Place[]>) => void;
  /** forecast handed to the swap engine (§7.6); default null = no gate */
  weather?: WeatherHour[] | null;
}

function mkDeps(opts: Opts = {}): SwapDeps {
  return {
    // calm by default; opts.weather drives the §7.6 gate case
    getWeather: async () => opts.weather ?? null,
    interpret: async (parsed, category, _currentStartISO, refinement) => {
      const localDuration = parseDurationExpr(refinement);
      const localTime = parseTimeExpr(refinement);
      // mirrors the real interpret: a time parse routes to time (carrying
      // any duration half); duration-only routes to duration
      const intent =
        opts.intent ??
        (localTime
          ? "time"
          : localDuration
          ? "duration"
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
        time: intent === "time" ? opts.time ?? localTime ?? null : null,
        duration:
          intent === "duration"
            ? opts.duration ?? localDuration ?? null
            : intent === "time"
            ? opts.duration ?? localDuration ?? null
            : null,
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
    isUsableAt: (place) => !(opts.unusableIds ?? []).includes(place.id),
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
    "parseTimeExpr: relative (signed) + absolute + non-time",
    async () => {
      assert.deepStrictEqual(parseTimeExpr("an hour earlier"), { mode: "relative", deltaMinutes: -60 });
      assert.deepStrictEqual(parseTimeExpr("30 min later"), { mode: "relative", deltaMinutes: 30 });
      assert.deepStrictEqual(parseTimeExpr("a bit later"), { mode: "relative", deltaMinutes: 30, vague: true });
      assert.deepStrictEqual(parseTimeExpr("a little earlier"), { mode: "relative", deltaMinutes: -30, vague: true });
      assert.deepStrictEqual(parseTimeExpr("half an hour earlier"), { mode: "relative", deltaMinutes: -30 });
      assert.deepStrictEqual(parseTimeExpr("much later"), { mode: "relative", deltaMinutes: 60, vague: true });
      assert.deepStrictEqual(parseTimeExpr("after 8"), { mode: "absolute", targetTime: "20:00" });
      assert.deepStrictEqual(parseTimeExpr("at 7:30"), { mode: "absolute", targetTime: "19:30" });
      assert.deepStrictEqual(parseTimeExpr("make it 7"), { mode: "absolute", targetTime: "19:00" });
      assert.strictEqual(parseTimeExpr("somewhere cheaper"), null);
    },
  ],
  [
    "TIME 'an hour earlier' shifts -60 and reflows the tail (venue kept)",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(17, 0));
      const res = await swapStop(
        it, 0, "an hour earlier", now,
        mkDeps({ time: { mode: "relative", deltaMinutes: -60 }, legMin: 10 })
      );
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "time");
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(18, 0)));
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(19, 45))); // 18:00 + 105
      assert.strictEqual(it.stops[0].id, "d1"); // open at the new time → kept
      assert.deepStrictEqual(res.downstreamShifted, [1, 2]);
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(19, 55))); // 19:45 + 10
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(21, 15))); // 21:05 + 10
    },
  ],
  [
    "TIME 'a bit later' defaults to +30 (via the deterministic parser)",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      // no explicit time → the fake interpret runs parseTimeExpr("a bit later")
      const res = await swapStop(it, 1, "a bit later", now, mkDeps({ legMin: 10 }));
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "time");
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(21, 30))); // 21:00 + 30
      assert.strictEqual(it.stops[1].id, "b1");
      assert.deepStrictEqual(res.downstreamShifted, [2]);
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(22, 50))); // 22:40 + 10
    },
  ],
  [
    "TIME 'after 8' (absolute) still works",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(17, 0));
      const res = await swapStop(it, 0, "can we start after 8", now, mkDeps({ legMin: 10 }));
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(20, 0)));
    },
  ],
  [
    "TIME shift that closes a later venue → ADAPTS (replaces the broken stop)",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      // bar an hour later → 22:00; dessert 's1' is closed by its new arrival
      const res = await swapStop(
        it, 1, "an hour later", now,
        mkDeps({ time: { mode: "relative", deltaMinutes: 60 }, legMin: 10, unusableIds: ["s1"] })
      );
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(22, 0))); // bar moved later
      assert.strictEqual(it.stops[1].id, "b1"); // bar itself still open → kept
      assert.notStrictEqual(it.stops[2].id, "s1"); // dessert replaced
      assert.strictEqual(it.stops[2].id, "dessert_fresh");
      assert.deepStrictEqual(res.downstreamShifted, [2]);
      assert.match(res.reason, /moved a later stop/i);
    },
  ],
  [
    "TIME shift where nothing adapts → fails loud, nothing committed",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      const res = await swapStop(
        it, 1, "an hour later", now,
        mkDeps({ time: { mode: "relative", deltaMinutes: 60 }, legMin: 10, unusableIds: ["s1"], pool: [] })
      );
      assert.strictEqual(res.swapped, false);
      if (!res.swapped) assert.match(res.reason, /Nothing similar to Dessert Spot is open/);
      // resettle failed before commit → bar untouched
      assert.strictEqual(it.stops[1].id, "b1");
      assert.strictEqual(it.stops[1].start_time, T(21, 0));
    },
  ],
  [
    "TIME shift never moves a locked downstream stop",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      it.stops[2].locked = true; // dessert locked (ratchet)
      const res = await swapStop(
        it, 1, "a bit later", now,
        mkDeps({ time: { mode: "relative", deltaMinutes: 30 }, legMin: 10 })
      );
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(21, 30))); // bar moved
      assert.strictEqual(it.stops[2].start_time, T(22, 20)); // locked dessert untouched
      assert.ok(!res.downstreamShifted.includes(2));
    },
  ],
  [
    "impossible time ('dinner at 4am') fails loud with the real reason",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      const res = await swapStop(
        it, 0, "can we do dinner at 4am", now,
        mkDeps({ time: { mode: "absolute", targetTime: "04:00" } })
      );
      assert.strictEqual(res.swapped, false);
      if (!res.swapped) assert.match(res.reason, /4:00 AM|won't work|nothing's really open/);
      assert.strictEqual(it.stops[0].id, "d1");
      assert.strictEqual(it.stops[0].start_time, T(19, 0));
    },
  ],
  [
    "parseDurationExpr: absolute + relative (signed) + non-duration",
    async () => {
      assert.deepStrictEqual(parseDurationExpr("stay 2 hours"), { mode: "absolute", targetMinutes: 120 });
      assert.deepStrictEqual(parseDurationExpr("make it 90 minutes"), { mode: "absolute", targetMinutes: 90 });
      assert.deepStrictEqual(parseDurationExpr("just an hour"), { mode: "absolute", targetMinutes: 60 });
      assert.deepStrictEqual(parseDurationExpr("stay longer"), { mode: "relative", deltaMinutes: 30 });
      assert.deepStrictEqual(parseDurationExpr("a lot longer"), { mode: "relative", deltaMinutes: 60 });
      assert.deepStrictEqual(parseDurationExpr("an extra hour"), { mode: "relative", deltaMinutes: 60 });
      assert.deepStrictEqual(parseDurationExpr("shorter"), { mode: "relative", deltaMinutes: -30 });
      assert.deepStrictEqual(parseDurationExpr("less time"), { mode: "relative", deltaMinutes: -30 });
      assert.strictEqual(parseDurationExpr("an hour earlier"), null); // that's a TIME request
      assert.strictEqual(parseDurationExpr("somewhere cheaper"), null);
    },
  ],
  [
    "DURATION 'stay 2 hours' extends the stop and reflows the tail",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(17, 0));
      const res = await swapStop(
        it, 0, "let's stay 2 hours", now,
        mkDeps({ duration: { mode: "absolute", targetMinutes: 120 }, legMin: 10 })
      );
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "duration");
      assert.strictEqual(it.stops[0].start_time, T(19, 0)); // start stays put
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(21, 0))); // 19:00 + 120
      assert.deepStrictEqual(res.downstreamShifted, [1, 2]);
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(21, 10))); // 21:00 + 10
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(22, 30))); // 22:20 + 10
      assert.match(res.reason, /Extended dinner to 2 hours/);
    },
  ],
  [
    "DURATION 'stay longer' defaults to +30 (via the deterministic parser)",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      const res = await swapStop(it, 1, "can we stay longer", now, mkDeps({ legMin: 10 }));
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "duration");
      assert.strictEqual(ms(it.stops[1].end_time), ms(T(22, 40))); // 21:00 + 100
      assert.deepStrictEqual(res.downstreamShifted, [2]);
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(22, 50))); // 22:40 + 10
    },
  ],
  [
    "DURATION 'shorter' = -30 and pulls the tail earlier",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      const res = await swapStop(it, 1, "make it shorter", now, mkDeps({ legMin: 10 }));
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(ms(it.stops[1].end_time), ms(T(21, 40))); // 21:00 + 40
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(21, 50))); // 21:40 + 10
      assert.match(res.reason, /Shortened bar to 40 minutes/);
    },
  ],
  [
    "DURATION extension that closes a later venue → ADAPTS it",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(17, 0));
      const res = await swapStop(
        it, 0, "stay 2 hours", now,
        mkDeps({ duration: { mode: "absolute", targetMinutes: 120 }, legMin: 10, unusableIds: ["s1"] })
      );
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(21, 0)));
      assert.notStrictEqual(it.stops[2].id, "s1"); // dessert replaced
      assert.strictEqual(it.stops[2].id, "dessert_fresh");
      assert.match(res.reason, /moved a later stop/i);
    },
  ],
  [
    "DURATION extension nothing can absorb → fails loud, nothing committed",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(17, 0));
      const res = await swapStop(
        it, 0, "stay 2 hours", now,
        mkDeps({ duration: { mode: "absolute", targetMinutes: 120 }, legMin: 10, unusableIds: ["s1"], pool: [] })
      );
      assert.strictEqual(res.swapped, false);
      if (!res.swapped) assert.match(res.reason, /Nothing similar to Dessert Spot is open/);
      assert.strictEqual(it.stops[0].end_time, T(20, 45)); // dinner untouched
    },
  ],
  [
    "DURATION 'stay 20 hours' fails loud (cap), and '10 minute dinner' fails loud (min)",
    async () => {
      const tooLong = await swapStop(
        mkItinerary(), 0, "stay 20 hours", new Date(T(17, 0)), mkDeps()
      );
      assert.strictEqual(tooLong.swapped, false);
      if (!tooLong.swapped) assert.match(tooLong.reason, /under 6 hours|longer than a single stop/);

      const it = mkItinerary();
      const tooShort = await swapStop(
        it, 0, "10 minute dinner", new Date(T(17, 0)),
        mkDeps({ duration: { mode: "absolute", targetMinutes: 10 } })
      );
      assert.strictEqual(tooShort.swapped, false);
      if (!tooShort.swapped) assert.match(tooShort.reason, /isn't enough time|at least/);
      assert.strictEqual(it.stops[0].end_time, T(20, 45)); // untouched
    },
  ],
  [
    "DURATION never moves a locked downstream stop",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      it.stops[2].locked = true;
      const res = await swapStop(
        it, 1, "stay longer", now,
        mkDeps({ duration: { mode: "relative", deltaMinutes: 30 }, legMin: 10 })
      );
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(ms(it.stops[1].end_time), ms(T(22, 40))); // bar extended
      assert.strictEqual(it.stops[2].start_time, T(22, 20)); // locked dessert untouched
      assert.ok(!res.downstreamShifted.includes(2));
    },
  ],
  [
    "parseTimeExpr: meridiem is applied — 6pm is 18:00, never 6 AM",
    async () => {
      assert.deepStrictEqual(parseTimeExpr("6pm"), { mode: "absolute", targetTime: "18:00" });
      assert.deepStrictEqual(parseTimeExpr("6 pm"), { mode: "absolute", targetTime: "18:00" });
      assert.deepStrictEqual(parseTimeExpr("6PM"), { mode: "absolute", targetTime: "18:00" });
      assert.deepStrictEqual(parseTimeExpr("9am"), { mode: "absolute", targetTime: "09:00" });
      // the classic edges
      assert.deepStrictEqual(parseTimeExpr("12pm"), { mode: "absolute", targetTime: "12:00" });
      assert.deepStrictEqual(parseTimeExpr("12am"), { mode: "absolute", targetTime: "00:00" });
      // bare colon time, no meridiem → afternoon/evening assumption
      assert.deepStrictEqual(parseTimeExpr("3:30"), { mode: "absolute", targetTime: "15:30" });
      // "to" phrasing must reach the parser — this was falling through to
      // the model, which dropped the PM
      assert.deepStrictEqual(parseTimeExpr("move it to 6pm"), { mode: "absolute", targetTime: "18:00" });
      assert.deepStrictEqual(parseTimeExpr("move it to 6:15pm"), { mode: "absolute", targetTime: "18:15" });
    },
  ],
  [
    "COMPOSE: 'make it 2 hours' then 'an hour earlier' keeps the 2-hour duration",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(17, 0));
      // 1) duration → 120: dinner 19:00–21:00
      const r1 = await swapStop(it, 0, "make it 2 hours", now, mkDeps({ legMin: 10 }));
      assert.ok(r1.swapped);
      assert.strictEqual(it.stops[0].durationMinutes?.total, 120);
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(21, 0)));
      // 2) time → -60: start shifts, the CUSTOM duration is the source of truth
      const r2 = await swapStop(it, 0, "an hour earlier", now, mkDeps({ legMin: 10 }));
      assert.ok(r2.swapped);
      if (!r2.swapped) return;
      assert.strictEqual(r2.path, "time");
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(18, 0)));
      assert.strictEqual(
        it.stops[0].durationMinutes?.total,
        120,
        "customized duration must survive a later time-swap"
      );
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(20, 0))); // 18:00 + 120, NOT +105
      // downstream chains off the preserved end: bar at 20:00 + 10 leg
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(20, 10)));
    },
  ],
  [
    "ABSOLUTE: 'move it to 6pm' lands the stop at 18:00 (not 6 AM)",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(16, 0));
      // no injected time — the deterministic parser must carry the PM
      const res = await swapStop(it, 0, "move it to 6pm", now, mkDeps({ legMin: 10 }));
      assert.ok(res.swapped, `expected a swap, got: ${JSON.stringify(res)}`);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "time");
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(18, 0)));
    },
  ],
  [
    "VENUE swap preserves a customized duration when the category is unchanged",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(17, 0));
      // customize dinner to 2 hours: 19:00–21:00, bar reflows to 21:10
      const r1 = await swapStop(it, 0, "make it 2 hours", now, mkDeps({ legMin: 10 }));
      assert.ok(r1.swapped);
      assert.strictEqual(it.stops[0].durationMinutes?.total, 120);
      // venue swap "cheaper" (refilter, same category) — the WHOLE slot
      // holds, length included
      const r2 = await swapStop(it, 0, "somewhere cheaper", now, mkDeps({ legMin: 10 }));
      assert.ok(r2.swapped);
      if (!r2.swapped) return;
      assert.strictEqual(r2.path, "refilter");
      assert.strictEqual(it.stops[0].id, "dinner_fresh"); // new venue
      assert.strictEqual(it.stops[0].start_time, T(19, 0)); // slot held
      assert.strictEqual(
        it.stops[0].durationMinutes?.total,
        120,
        "customized duration must survive a venue swap"
      );
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(21, 0))); // 19:00 + 120
      // buffer preserved, base absorbs the customization (buildStop semantics)
      assert.strictEqual(it.stops[0].durationMinutes?.buffer, 15);
      assert.strictEqual(it.stops[0].durationMinutes?.base, 105);
      // bar already sits at 21:10 (from the reflow) → no further shift
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(21, 10)));
    },
  ],
  [
    "VENUE swap that CHANGES category drops the old duration for the new default",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(17, 0));
      // customize the bar to 2 hours: 21:00–23:00, dessert reflows to 23:10
      const r1 = await swapStop(it, 1, "stay 2 hours", now, mkDeps({ legMin: 10 }));
      assert.ok(r1.swapped);
      assert.strictEqual(it.stops[1].durationMinutes?.total, 120);
      // research swap into a different KIND of place → restaurant default (105)
      const r2 = await swapStop(
        it, 1, "make it a proper restaurant instead", now,
        mkDeps({ path: "research", newCategory: "restaurant", legMin: 10 })
      );
      assert.ok(r2.swapped);
      if (!r2.swapped) return;
      assert.strictEqual(it.stops[1].category, "restaurant");
      assert.strictEqual(
        it.stops[1].durationMinutes?.total,
        105,
        "a category change takes the new category's default"
      );
      assert.strictEqual(ms(it.stops[1].end_time), ms(T(22, 45))); // 21:00 + 105
      // shorter than before → dessert (23:10) isn't overflowed, stays put
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(23, 10)));
    },
  ],
  [
    "REGRESSION A: 'start at 6pm' phrasings are TIME, never duration",
    async () => {
      for (const p of ["start at 6pm", "make it start at 6pm"]) {
        assert.strictEqual(parseDurationExpr(p), null, `"${p}" must not parse as duration`);
        assert.deepStrictEqual(parseTimeExpr(p), { mode: "absolute", targetTime: "18:00" });
      }
      // the duration-unit guard: a number owned by "hours" is not a clock time
      assert.strictEqual(parseTimeExpr("make it 2 hours"), null);
      assert.deepStrictEqual(parseDurationExpr("make it 2 hours"), { mode: "absolute", targetMinutes: 120 });
      // through the engine: start moves, duration untouched
      const it = mkItinerary();
      const res = await swapStop(it, 0, "make it start at 6pm", new Date(T(16, 0)), mkDeps({ legMin: 10 }));
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "time");
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(18, 0)));
      assert.strictEqual(it.stops[0].durationMinutes?.total, 105, "duration unchanged");
    },
  ],
  [
    "REGRESSION A2: compound 'start at 6pm for 2 hours' applies BOTH halves",
    async () => {
      assert.deepStrictEqual(parseTimeExpr("start at 6pm for 2 hours"), { mode: "absolute", targetTime: "18:00" });
      assert.deepStrictEqual(parseDurationExpr("start at 6pm for 2 hours"), { mode: "absolute", targetMinutes: 120 });
      const it = mkItinerary();
      const res = await swapStop(it, 0, "start at 6pm for 2 hours", new Date(T(16, 0)), mkDeps({ legMin: 10 }));
      assert.ok(res.swapped);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "time");
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(18, 0)));
      assert.strictEqual(it.stops[0].durationMinutes?.total, 120);
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(20, 0)));
      assert.match(res.reason, /Moved dinner to 6:00 PM for 2 hours/);
    },
  ],
  [
    "REGRESSION B: explicit '6am' is honored — 06:00, meridiem never flipped",
    async () => {
      assert.deepStrictEqual(parseTimeExpr("6am"), { mode: "absolute", targetTime: "06:00" });
      assert.deepStrictEqual(parseTimeExpr("start at 6am"), { mode: "absolute", targetTime: "06:00" });
      assert.deepStrictEqual(parseTimeExpr("move it to 6am"), { mode: "absolute", targetTime: "06:00" });
      // bare times still assume PM ("6" alone, "at 6")
      assert.deepStrictEqual(parseTimeExpr("6"), { mode: "absolute", targetTime: "18:00" });
      assert.deepStrictEqual(parseTimeExpr("at 6"), { mode: "absolute", targetTime: "18:00" });
      // a 6 AM move on a morning-plausible category actually lands
      const it = createItinerary(
        [{ ...mkStops()[0], category: "breakfast", name: "Breakfast Spot", start_time: T(10, 0), end_time: T(11, 45) }],
        [],
        { time_window: "morning", stop_count: null, aesthetic: "unspecified", category_signals: ["breakfast"], group_context: "solo", budget: null, constraints: [], location: "Ossington" }
      );
      const res = await swapStop(it, 0, "move it to 6am", new Date(T(4, 0)), mkDeps({ legMin: 10 }));
      assert.ok(res.swapped, `expected 6am breakfast to land, got: ${JSON.stringify(res)}`);
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(6, 0)));
    },
  ],
  [
    "REGRESSION C: multi-swap sequence stays coherent — no drift",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(16, 0));
      const steps: Array<[string, number, number, number]> = [
        // refinement, expected start h/m, expected total
        ["make it 2 hours", 19, 0, 120],
        ["make it start at 6pm", 18, 0, 120],
        ["an hour earlier", 17, 0, 120],
        ["a bit later", 17, 30, 120],
      ];
      for (const [refinement, h, m, total] of steps) {
        const res = await swapStop(it, 0, refinement, now, mkDeps({ legMin: 10 }));
        assert.ok(res.swapped, `"${refinement}" refused: ${JSON.stringify(res)}`);
        assert.strictEqual(ms(it.stops[0].start_time), ms(T(h, m)), `start after "${refinement}"`);
        assert.strictEqual(it.stops[0].durationMinutes?.total, total, `total after "${refinement}"`);
      }
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(19, 30))); // 17:30 + 120
    },
  ],
  [
    "interpret floor holds against a lying model (classification, meridiem, garbage deltas)",
    async () => {
      // stub Groq to return deliberately wrong output per call
      const realFetch = globalThis.fetch;
      let modelOut = "{}";
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("api.groq.com")) {
          return new Response(
            JSON.stringify({ choices: [{ message: { content: modelOut } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
      const parsed = {
        time_window: "evening", stop_count: null, aesthetic: "lively",
        category_signals: ["dinner"], group_context: "date",
        budget: null, constraints: [], location: "Ossington",
      };
      const model = (o: object) => (modelOut = JSON.stringify(o));
      const run = (refinement: string) =>
        interpretRefinement("test-key", parsed, "dinner", T(19, 0), refinement);
      try {
        // model misclassifies the start request as duration-120 → floor forces time 18:00
        model({ intent: "duration", path: "refilter", category: "dinner", duration: { mode: "absolute", targetMinutes: 120 }, time: null });
        const a = await run("make it start at 6pm");
        assert.strictEqual(a.intent, "time");
        assert.deepStrictEqual(a.time, { mode: "absolute", targetTime: "18:00" });
        assert.strictEqual(a.duration, null);

        // model flips 6am to 18:00 → local explicit meridiem wins
        model({ intent: "time", path: "refilter", category: "dinner", time: { mode: "absolute", targetTime: "18:00" }, duration: null });
        const b = await run("move it to 6am");
        assert.deepStrictEqual(b.time, { mode: "absolute", targetTime: "06:00" });

        // model returns a garbage delta for an EXACT local relative → local wins
        model({ intent: "time", path: "refilter", category: "dinner", time: { mode: "relative", deltaMinutes: -540 }, duration: null });
        const c = await run("an hour earlier");
        assert.deepStrictEqual(c.time, { mode: "relative", deltaMinutes: -60 });

        // model flips the SIGN of a vague relative → rejected, local default kept
        model({ intent: "time", path: "refilter", category: "dinner", time: { mode: "relative", deltaMinutes: 30 }, duration: null });
        const d = await run("a bit earlier");
        assert.deepStrictEqual(d.time, { mode: "relative", deltaMinutes: -30 });

        // a SANE model refinement of a vague relative is still allowed
        model({ intent: "time", path: "refilter", category: "dinner", time: { mode: "relative", deltaMinutes: -45 }, duration: null });
        const e = await run("a bit earlier");
        assert.deepStrictEqual(e.time, { mode: "relative", deltaMinutes: -45 });
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
  [
    "MULTI-CITY: a time-swap on the FIRST stop departs from the itinerary's own home",
    async () => {
      const it = mkItinerary();
      // a per-plan geocoded home (e.g. a Vancouver address), not the default
      it.home = { label: "Start · 800 Robson St", location: { latitude: 49.2827, longitude: -123.1207 } };
      const origins: Array<{ latitude: number; longitude: number }> = [];
      const deps = mkDeps({ legMin: 10 });
      const realLeg = deps.getSingleLeg;
      deps.getSingleLeg = async (o, d, fi, dep, ex) => {
        origins.push(o as { latitude: number; longitude: number });
        return realLeg(o, d, fi, dep, ex);
      };
      // move dinner (stop 0) earlier — its inbound leg departs from HOME
      const res = await swapStop(it, 0, "an hour earlier", new Date(T(17, 0)), deps);
      assert.ok(res.swapped);
      // the home→dinner leg used the ITINERARY's home, not the module default
      const homeOrigin = origins.find((o) => Math.abs(o.latitude - 49.2827) < 1e-6);
      assert.ok(homeOrigin, `expected an origin at the custom home, got ${JSON.stringify(origins)}`);
    },
  ],
  [
    "MULTI-CITY: an absolute time-swap lands 6pm in the PLAN's zone, never Toronto's",
    async () => {
      // Regression pin for the Phase-5 timeChange fix. A Vancouver plan
      // carries Pacific wall times and its real IANA zone. "move it to 6pm"
      // must set 18:00 PACIFIC (−07:00), never 18:00 Toronto (−04:00) — the
      // bug was setHours() in the SERVER's local zone, which on the Toronto
      // dev box would render a Vancouver plan three hours wrong. The two
      // instants differ by 3h, so this assertion actually discriminates.
      const it = createItinerary(
        [
          {
            category: "dinner", id: "vd1", name: "Vancouver Dinner",
            start_time: V(19, 0), end_time: V(20, 45),
            durationMinutes: { base: 90, buffer: 15, total: 105 },
            location: { latitude: 49.2827, longitude: -123.1207 },
            travelMinutesToNext: 15, travelToNext: leg(0, "transit", 15),
          },
          {
            category: "bar", id: "vb1", name: "Vancouver Bar",
            start_time: V(21, 0), end_time: V(22, 10),
            durationMinutes: { base: 60, buffer: 10, total: 70 },
            location: { latitude: 49.282, longitude: -123.118 },
          },
        ],
        [leg(0, "transit", 15)],
        {
          time_window: "evening", stop_count: null, aesthetic: "lively",
          category_signals: ["dinner", "bar"], group_context: "date",
          budget: null, constraints: [], location: "Gastown",
        },
        null,
        null,
        "America/Vancouver"
      );
      const now = new Date(V(16, 0)); // 4pm Pacific → dinner still upcoming
      const res = await swapStop(it, 0, "move it to 6pm", now, mkDeps({ legMin: 10 }));
      assert.ok(res.swapped, `expected a swap, got: ${JSON.stringify(res)}`);
      if (!res.swapped) return;
      assert.strictEqual(res.path, "time");
      // the pin: 18:00 in Vancouver, not in Toronto
      assert.strictEqual(it.stops[0].start_time, V(18, 0));
      assert.strictEqual(ms(it.stops[0].start_time), ms(V(18, 0)));
      // explicitly NOT the Toronto-6pm instant the pre-fix code produced on a
      // Toronto-local server
      assert.notStrictEqual(ms(it.stops[0].start_time), ms(T(18, 0)));
      // the kept 105-min duration also renders in Pacific (18:00 + 105 = 19:45)
      assert.strictEqual(it.stops[0].end_time, V(19, 45));
      assert.match(res.reason, /6:00 PM/);
    },
  ],
  [
    "swap-produced stops carry the pick's REAL description, distinct from the reason",
    async () => {
      // venue swap (finalize path): the new stop's description is the
      // candidate's Places editorialSummary — never the Groq reason
      const it = mkItinerary();
      const res = await swapStop(it, 1, "somewhere cheaper", new Date(T(18, 0)), mkDeps({ legMin: 10 }));
      assert.ok(res.swapped);
      const s = it.stops[1];
      assert.strictEqual(s.description, "New bar_fresh, a real spot on the strip.");
      assert.ok(s.reason, "swap stop should carry a reason too");
      assert.notStrictEqual(s.description, s.reason, "description must not be the reason");

      // adapt path (buildStop pick branch): a time shift that closes a later
      // venue replaces it — the replacement also carries its own editorial
      const it2 = mkItinerary();
      const r2 = await swapStop(
        it2, 1, "an hour later", new Date(T(18, 0)),
        mkDeps({ time: { mode: "relative", deltaMinutes: 60 }, legMin: 10, unusableIds: ["s1"] })
      );
      assert.ok(r2.swapped);
      const d = it2.stops[2];
      assert.strictEqual(d.id, "dessert_fresh");
      assert.strictEqual(d.description, "New dessert_fresh, a real spot on the strip.");
      assert.notStrictEqual(d.description, d.reason);
    },
  ],
  [
    "CLOSER: a 'closer' swap ranks by CODE-computed distance and lands the nearest venue",
    async () => {
      // anchor = the previous timed stop (dinner at 43.647,-79.42); the
      // current bar (43.649,-79.41) is ~840m from it. Pool lists the FAR
      // venue first — without distance ranking the fake select (first-in-
      // pool) would pick it; the engine must filter to strictly-closer and
      // sort nearest-first.
      const far = { ...mkVenue("b_far", "Far Bar"), location: { latitude: 43.66, longitude: -79.4 } };
      const near = { ...mkVenue("b_near", "Near Bar"), location: { latitude: 43.6475, longitude: -79.4185 } };
      const it = mkItinerary();
      const res = await swapStop(it, 1, "somewhere closer", new Date(T(18, 0)), mkDeps({ pool: [far, near], legMin: 5 }));
      assert.ok(res.swapped, `expected a swap, got: ${JSON.stringify(res)}`);
      if (!res.swapped) return;
      assert.strictEqual(it.stops[1].id, "b_near");
      // distance genuinely reduced vs the original venue (both from dinner)
      const dist = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
        const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
        const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
        const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.latitude * Math.PI) / 180) * Math.cos((b.latitude * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        return 2 * 6371000 * Math.asin(Math.sqrt(s));
      };
      const anchor = { latitude: 43.647, longitude: -79.42 }; // dinner
      assert.ok(
        dist(anchor, it.stops[1].location!) < dist(anchor, { latitude: 43.649, longitude: -79.41 }),
        "new venue must be nearer the anchor than the original"
      );
      // slot held (a closer-swap is still a venue swap)
      assert.strictEqual(it.stops[1].start_time, T(21, 0));
    },
  ],
  [
    "CLOSER: nothing nearer → honest refusal, original kept",
    async () => {
      // pool holds only venues FARTHER from the anchor than the current bar
      const far = { ...mkVenue("b_far", "Far Bar"), location: { latitude: 43.66, longitude: -79.4 } };
      const it = mkItinerary();
      const res = await swapStop(it, 1, "somewhere closer", new Date(T(18, 0)), mkDeps({ pool: [far] }));
      assert.strictEqual(res.swapped, false);
      if (!res.swapped) assert.match(res.reason, /closer than Bar Spot — it's already the closest/);
      assert.strictEqual(it.stops[1].id, "b1"); // untouched
    },
  ],
  [
    "CLOSER on the FIRST stop anchors to the itinerary's home",
    async () => {
      const it = mkItinerary();
      // home at the dessert end of the strip — "closer" for the dinner stop
      // must mean closer to HOME, not to any downstream stop
      it.home = { label: "Start · custom", location: { latitude: 43.6502, longitude: -79.4045 } };
      // dinner (43.647,-79.42) is ~1.3km from home; near-home candidate wins
      const nearHome = { ...mkVenue("d_near", "Near Dinner"), location: { latitude: 43.6503, longitude: -79.405 } };
      const farAway = { ...mkVenue("d_far", "Far Dinner"), location: { latitude: 43.62, longitude: -79.5 } };
      const res = await swapStop(it, 0, "find a closer dinner", new Date(T(17, 0)), mkDeps({ pool: [farAway, nearHome], legMin: 5 }));
      assert.ok(res.swapped, `expected a swap, got: ${JSON.stringify(res)}`);
      assert.strictEqual(it.stops[0].id, "d_near");
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
  [
    "§2.3: a venue swap stops reflowing AT a locked stop, never shifts past it",
    async () => {
      // Contrived but reachable via dev time-travel + a prior time swap: a
      // LOCKED stop sits between the swapped stop and a later one. finalize
      // used `continue`, so it skipped the locked stop and kept shifting the
      // ones beyond it — the ratchet held, but the chain stopped being
      // consistent. resettleTail has always used `break` here.
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      // hand-lock the MIDDLE stop while the first is still upcoming
      withStatuses(it, now);
      it.stops[1].locked = true;
      const dessertStart = it.stops[2].start_time;
      const dessertEnd = it.stops[2].end_time;
      // swap stop 0 for a LONGER kind of stop (museum = 120 vs dinner's
      // 105) so the tail genuinely overflows and the reflow loop runs
      const res = await swapStop(it, 0, "a museum instead", now,
        mkDeps({ path: "research", newCategory: "museum", legMin: 10 }));
      assert.ok(res.swapped);
      if (!res.swapped) return;
      // the locked stop is untouched (the ratchet, as always)...
      assert.strictEqual(it.stops[1].id, "b1");
      assert.strictEqual(it.stops[1].start_time, T(21, 0));
      // ...and so is everything BEYOND it — the reflow stopped at the lock
      // rather than stepping over it
      assert.strictEqual(it.stops[2].start_time, dessertStart);
      assert.strictEqual(it.stops[2].end_time, dessertEnd);
      assert.deepStrictEqual(res.downstreamShifted, []);
    },
  ],
  [
    "§7.3: a bare hour keeps AM when the stop's category band wants it",
    async () => {
      // no category → the outing-planner PM default, unchanged
      assert.deepStrictEqual(parseTimeExpr("make it 10"), { mode: "absolute", targetTime: "22:00" });
      // brunch runs 8–15: 10 AM fits, 10 PM doesn't → keep AM. Pre-fix this
      // became 22:00 and was refused with "A 10:00 PM brunch won't work",
      // which is a confusing answer to a request that meant 10 AM.
      assert.deepStrictEqual(parseTimeExpr("make it 10", "brunch"), {
        mode: "absolute",
        targetTime: "10:00",
      });
      assert.deepStrictEqual(parseTimeExpr("at 9", "breakfast"), {
        mode: "absolute",
        targetTime: "09:00",
      });
      // dinner runs 11–23: BOTH 7 AM and 7 PM are outside/inside such that
      // the evening reading stands — the PM default must not be weakened
      assert.deepStrictEqual(parseTimeExpr("at 7", "dinner"), {
        mode: "absolute",
        targetTime: "19:00",
      });
      assert.deepStrictEqual(parseTimeExpr("make it 8", "bar"), {
        mode: "absolute",
        targetTime: "20:00",
      });
      // an explicit meridiem always wins over any band reasoning
      assert.deepStrictEqual(parseTimeExpr("make it 10pm", "brunch"), {
        mode: "absolute",
        targetTime: "22:00",
      });
      assert.deepStrictEqual(parseTimeExpr("make it 10am", "dinner"), {
        mode: "absolute",
        targetTime: "10:00",
      });
    },
  ],
  [
    "§7.6: a swap consults the forecast — an outdoor stop isn't moved into the rain",
    async () => {
      // rain over the whole window; the park pool is weather-blocked, so
      // the swap refuses honestly instead of planning a soggy stop
      const rain: WeatherHour[] = Array.from({ length: 24 }, (_, i) => ({
        hourISO: new Date(new Date(T(12, 0)).getTime() + i * 3_600_000).toISOString(),
        tempC: 14,
        precipProbability: 90,
        condition: "Rain",
      }));
      const it = mkItinerary();
      it.home = { label: "Start", location: { latitude: 43.65, longitude: -79.4 } };
      it.stops[1].category = "park walk"; // an outdoor stop to swap
      const res = await swapStop(it, 1, "somewhere else outdoors", new Date(T(18, 0)),
        mkDeps({ weather: rain, pool: [mkVenue("park_new")] }));
      assert.strictEqual(res.swapped, false, "rain must block the outdoor pool");
      // and with calm weather the same swap goes through
      const it2 = mkItinerary();
      it2.home = { label: "Start", location: { latitude: 43.65, longitude: -79.4 } };
      it2.stops[1].category = "park walk";
      const ok = await swapStop(it2, 1, "somewhere else outdoors", new Date(T(18, 0)),
        mkDeps({ weather: null, pool: [mkVenue("park_new")] }));
      assert.ok(ok.swapped, "calm weather must not block it");
    },
  ],
  // ── missing stored parse (code-audit 2026-07-18 §3.1) ──
  // Both engines used to fall back to a hardcoded `location: "Ossington"`
  // with no city, so a re-search for a non-Toronto plan quietly went
  // looking in Toronto's west end. Neither fallback branch had any test.
  [
    "§3.1: no stored parse on a TORONTO plan → fallback searches, inventing no neighbourhood",
    async () => {
      const it = mkItinerary();
      delete it.parsed; // pre-multi-city itinerary
      let searchedLocation: string | null = null;
      const deps = mkDeps({ legMin: 10 });
      const res = await swapStop(it, 1, "somewhere cheaper", new Date(T(18, 0)), {
        ...deps,
        searchPools: async (parsed, cats) => {
          searchedLocation = parsed.location;
          return { [cats[0]]: [mkVenue("fallback_pick")] };
        },
      });
      assert.ok(res.swapped, "a Toronto plan should still be swappable");
      // no invented neighbourhood — searches the city broadly instead
      assert.strictEqual(searchedLocation, "");
    },
  ],
  [
    "§3.1: no stored parse on a VANCOUVER plan → refuses honestly, never searches Toronto",
    async () => {
      const it = mkItinerary();
      delete it.parsed;
      it.timeZone = "America/Vancouver"; // knowably NOT Toronto
      let searched = false;
      const deps = mkDeps({ legMin: 10 });
      const res = await swapStop(it, 1, "somewhere cheaper", new Date(T(18, 0)), {
        ...deps,
        searchPools: async (parsed, cats) => {
          searched = true;
          return { [cats[0]]: [mkVenue("wrong_city")] };
        },
      });
      assert.strictEqual(res.swapped, false, "must not guess a city");
      assert.strictEqual(searched, false, "must not search at all");
      if (!res.swapped) assert.match(res.reason, /missing the details/i);
      // the stop is left exactly as it was
      assert.strictEqual(it.stops[1].id, "b1");
    },
  ],
  // ── the PRODUCTION availability default (code-audit 2026-07-18 §1.1) ──
  // Every case above injects its own isUsableAt, so `usableByHours` — the
  // real seam implementation — had zero coverage. These exercise it directly
  // and in situ, with NO stub. Instants are explicit and absolute, so the
  // assertions hold under any runner TZ (verified under TZ=UTC too).
  [
    "REGRESSION §1.1: usableByHours judges the PLAN's zone, not the server's",
    async () => {
      // Mon–Sun 09:00–17:00 local.
      const venue: Place = {
        id: "v_hours",
        displayName: { text: "Nine To Five" },
        currentOpeningHours: {
          periods: Array.from({ length: 7 }, (_, day) => ({
            open: { day, hour: 9, minute: 0 },
            close: { day, hour: 17, minute: 0 },
          })),
        },
      };
      // 23:30 UTC = 16:30 Vancouver (OPEN) / 19:30 Toronto (closed).
      const when = new Date("2026-07-06T23:30:00Z");
      assert.strictEqual(usableByHours(venue, when, "dinner", "America/Vancouver"), true);
      assert.strictEqual(usableByHours(venue, when, "dinner", "America/Toronto"), false);
      // day-of-week half: Mon 20:30 Vancouver is already Tuesday in UTC
      const mondayOnly: Place = {
        id: "v_mon",
        currentOpeningHours: {
          periods: [{ open: { day: 1, hour: 20, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }],
        },
      };
      const monNight = new Date("2026-07-07T03:30:00Z");
      assert.strictEqual(usableByHours(mondayOnly, monNight, "bar", "America/Vancouver"), true);
      assert.strictEqual(usableByHours(mondayOnly, monNight, "bar", "UTC"), false);
      // keep-on-missing: a venue with no hours data is never ruled out
      assert.strictEqual(usableByHours({ id: "v_none" }, when, "bar", "UTC"), true);
    },
  ],
  [
    "the real availability default is wired in when deps omit isUsableAt",
    async () => {
      // No stub at all — swapStop falls through to realDeps().isUsableAt.
      // Stored stops carry no hours, so keep-on-missing keeps the venue and
      // the time-swap completes; this pins the WIRING (signature, zone
      // argument, no crash) that the stubbed cases can't see.
      const it = mkItinerary();
      const { isUsableAt: _omitted, ...depsWithoutSeam } = mkDeps({ legMin: 10 });
      // dessert (last stop, 22:20) pushed an hour later — no downstream tail
      // and no collision with the bar's 22:10 end, so the ONLY thing that can
      // refuse this is the availability seam.
      const res = await swapStop(it, 2, "an hour later", new Date(T(18, 0)), depsWithoutSeam);
      assert.ok(res.swapped, "swap should complete on the production default");
      if (!res.swapped) return;
      assert.strictEqual(res.path, "time");
      assert.strictEqual(it.stops[2].start_time, T(23, 20));
      assert.strictEqual(it.stops[2].id, "s1"); // kept, not adapted
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
