// Per-stop swap engine tests — surgical replacement, held slot, floor_time
// protection. Pipeline deps are injected fakes; no network.
// Run with: npx tsx app/api/itinerary/swap.test.ts
import assert from "node:assert";
import { createItinerary, withStatuses } from "./store";
import {
  swapStop,
  SwapDeps,
  parseTimeExpr,
  parseDurationExpr,
  TimeShift,
  DurationShift,
} from "./swap";
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
}

function mkDeps(opts: Opts = {}): SwapDeps {
  return {
    interpret: async (parsed, category, _currentStartISO, refinement) => {
      const localDuration = parseDurationExpr(refinement);
      const localTime = parseTimeExpr(refinement);
      const intent =
        opts.intent ??
        (localDuration
          ? "duration"
          : localTime
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
        time: intent === "time" ? opts.time ?? localTime ?? null : null,
        duration: intent === "duration" ? opts.duration ?? localDuration ?? null : null,
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
      assert.deepStrictEqual(parseTimeExpr("a bit later"), { mode: "relative", deltaMinutes: 30 });
      assert.deepStrictEqual(parseTimeExpr("a little earlier"), { mode: "relative", deltaMinutes: -30 });
      assert.deepStrictEqual(parseTimeExpr("half an hour earlier"), { mode: "relative", deltaMinutes: -30 });
      assert.deepStrictEqual(parseTimeExpr("much later"), { mode: "relative", deltaMinutes: 60 });
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
