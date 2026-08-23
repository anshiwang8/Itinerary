// Mode-switch engine tests — the re-pricing, the venues that must survive it,
// the clamp that is what makes them survive it, the floor, the no-op, and
// plan-then-commit.
//
// TWO KINDS OF CASE LIVE HERE, deliberately, and the split is the point.
//
//  - THE MODE-BINDING CASES inject every dep EXCEPT `getSingleLeg`, so the
//    leg fetcher comes from the engine's own `realDeps(target)` — which,
//    under E2E_MOCK, is the fixture builder. That covers the whole chain at
//    once: requested mode → `realDeps(mode)` → `mockSwapDeps(..., mode)` →
//    `mockLeg(..., mode)`. It is the ONLY shape that can prove a switch
//    actually changes how legs are priced rather than just relabelling the
//    plan, which is the exact failure Stage 1's engine suite was built
//    around. Break the binding at any link and these go red.
//
//  - THE SCHEDULING CASES inject `getSingleLeg` too, because the clamp, the
//    floor and the refusals are about ARITHMETIC and need leg lengths chosen
//    to the minute.
//
// Run with: npx tsx app/api/itinerary/modeSwitch.test.ts

// Set BEFORE the engine is used: `isMockMode()` reads the env var at call
// time, so this makes realDeps() hand back the fixture deps.
process.env.E2E_MOCK = "1";

import assert from "node:assert";
import { createItinerary, withStatuses, Itinerary } from "./store";
import { switchTravelMode } from "./modeSwitch";
import { SwapDeps } from "./swap";
import { Place, WeatherHour } from "../places/search/filter";
import { ScheduledStop } from "../schedule/schedule";
import type { CurrentOpeningHours } from "../places/search/hours";
import { PlanTravelMode, TravelLeg } from "../schedule/travel";

const T = (h: number, m: number) =>
  `2026-07-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`;
const ms = (iso: string | null | undefined) => new Date(iso!).getTime();

// Deliberately spread ~3 km apart, comfortably past
// DRIVING_SHORT_LEG_WALK_METERS, so a driving plan's fixture legs really are
// drives and a mode assertion is about the MODE rather than the threshold.
const A = { latitude: 43.6547, longitude: -79.3862 };
const B = { latitude: 43.6847, longitude: -79.3862 };
const C = { latitude: 43.7147, longitude: -79.3862 };

function leg(
  fromIndex: number,
  mode: "transit" | "walk" | "driving",
  total: number
): TravelLeg {
  return {
    fromIndex,
    mode,
    rawMinutes: mode === "driving" ? total - 10 : mode === "transit" ? total - 5 : total,
    marginMinutes: mode === "driving" ? 10 : mode === "transit" ? 5 : 0,
    totalMinutes: total,
    distanceMeters: 3_300,
    encodedPolyline: "enc_stored",
  };
}

/** Same hours every day, so a case never depends on which weekday the fixture
 *  date lands on. `closeH <= openH` wraps past midnight. */
function openHours(openH: number, closeH: number, closeM = 0): CurrentOpeningHours {
  return {
    periods: Array.from({ length: 7 }, (_, day) => ({
      open: { day, hour: openH, minute: 0 },
      close: {
        day: closeH <= openH ? (day + 1) % 7 : day,
        hour: closeH % 24,
        minute: closeM,
      },
    })),
  };
}

// dinner 19:00–20:45 (105) → bar 21:00–22:10 (70) → dessert 22:20–23:00 (40)
function mkStops(): ScheduledStop[] {
  return [
    {
      category: "dinner",
      id: "d1",
      name: "Dinner Spot",
      start_time: T(19, 0),
      end_time: T(20, 45),
      durationMinutes: { base: 90, buffer: 15, total: 105 },
      location: A,
      travelMinutesToNext: 15,
      travelToNext: leg(0, "transit", 15),
    },
    {
      category: "bar",
      id: "b1",
      name: "Bar Spot",
      start_time: T(21, 0),
      end_time: T(22, 10),
      durationMinutes: { base: 60, buffer: 10, total: 70 },
      location: B,
      travelMinutesToNext: 10,
      travelToNext: leg(1, "transit", 10),
    },
    {
      category: "dessert",
      id: "s1",
      name: "Dessert Spot",
      start_time: T(22, 20),
      end_time: T(23, 0),
      durationMinutes: { base: 30, buffer: 10, total: 40 },
      location: C,
    },
  ];
}

const PARSED = {
  time_window: "evening",
  stop_count: null,
  aesthetic: "lively",
  category_signals: ["dinner", "bar", "dessert"],
  group_context: "date",
  budget: null,
  constraints: [],
  location: "Ossington",
  // `weatherFor` returns null WITHOUT calling the seam when a plan carries
  // neither a city centre nor a home, so the fixture carries one for the
  // "spent nothing" assertions to mean anything. It changes no outcome: the
  // injected forecast is null, the keep-on-missing value the gate already had.
  cityCenter: { latitude: 43.6532, longitude: -79.3832 },
};

function mkItinerary(
  travelMode: PlanTravelMode | undefined,
  homeLeg?: TravelLeg | null,
  plannedEndISO?: string | null
): Itinerary {
  return createItinerary(
    mkStops(),
    [leg(0, "transit", 15), leg(1, "transit", 10)],
    PARSED,
    homeLeg ?? null,
    { label: "Home", location: A },
    null,
    plannedEndISO ?? null,
    travelMode
  );
}

function mkVenue(id: string, name = `New ${id}`): Place {
  return {
    id,
    displayName: { text: name },
    rating: 4.5,
    businessStatus: "OPERATIONAL",
    location: { latitude: 43.751, longitude: -79.3862 },
    editorialSummary: { text: `${name}, a real spot.` },
  };
}

interface Opts {
  legMin?: number;
  /** ids treated as closed by the availability seam */
  unusableIds?: string[];
  /** make every route lookup fail — the plan-then-commit fixture */
  legFails?: boolean;
  weather?: WeatherHour[] | null;
  onSearch?: () => void;
  onSelect?: () => void;
  onInterpret?: () => void;
}

/**
 * EVERY dep except `getSingleLeg` — the omission the mode-binding cases turn
 * on. `searchPools`/`selectVenues`/`interpret` are wired to RECORD rather than
 * to throw, so a case can assert "a mode switch spends nothing on venues"
 * with a count instead of relying on an exception to be surfaced.
 */
function depsWithoutLegs(opts: Opts = {}): Partial<SwapDeps> {
  return {
    getWeather: async () => opts.weather ?? null,
    interpret: async () => {
      opts.onInterpret?.();
      throw new Error("a mode switch must never ask the model to interpret anything");
    },
    searchPools: async (_parsed, cats) => {
      opts.onSearch?.();
      const key = cats[0];
      return { [key]: [mkVenue(`${key}_fresh`)] };
    },
    selectVenues: async (_parsed, pools) => {
      opts.onSelect?.();
      return Object.entries(pools).map(([category, arr]) =>
        arr.length
          ? {
              category,
              id: arr[0].id,
              reason: `A fresh ${category} that fits.`,
              name: arr[0].displayName?.text,
              rating: arr[0].rating,
            }
          : { category, id: null, reason: "no venues survived filtering" }
      );
    },
    isUsableAt: (place) => !(opts.unusableIds ?? []).includes(place.id),
  };
}

/** ...plus a leg fetcher, for the cases that need exact arithmetic. */
function mkDeps(opts: Opts = {}): Partial<SwapDeps> {
  return {
    ...depsWithoutLegs(opts),
    getSingleLeg: async (_o, _d, fromIndex) => {
      if (opts.legFails) throw new Error("routes unavailable");
      return {
        fromIndex,
        mode: "driving",
        rawMinutes: Math.max(0, (opts.legMin ?? 10) - 10),
        marginMinutes: 10,
        totalMinutes: opts.legMin ?? 10,
        distanceMeters: 3_300,
        encodedPolyline: "enc_new",
      };
    },
  };
}

/** Every venue id still in the plan, in order — the "no silent substitution"
 *  assertion in one value. */
const venueIds = (it: Itinerary) => it.stops.map((s) => s.id);
/** Every venue NAME still in the plan — the same assertion the user would
 *  make by looking at the strip. */
const venueNames = (it: Itinerary) => it.stops.map((s) => s.name);

/** Every leg the plan now holds, home leg included. */
function allLegs(it: Itinerary): TravelLeg[] {
  return [
    ...(it.homeLeg ? [it.homeLeg] : []),
    ...it.stops.flatMap((s) => (s.travelToNext ? [s.travelToNext] : [])),
  ];
}

/** The legs a mutation actually re-priced, identified by losing the stored
 *  fixture polyline. Untouched legs keep `enc_stored`. */
function recomputedLegs(it: Itinerary): TravelLeg[] {
  return allLegs(it).filter((l) => l.encodedPolyline !== "enc_stored");
}

const cases: Array<[string, () => Promise<void>]> = [
  // ───────────────────────── the mode binding ─────────────────────────
  [
    "TRANSIT → DRIVING re-prices every leg ahead in the NEW mode, and every venue survives",
    async () => {
      // No `getSingleLeg` injected: the legs come from realDeps(target),
      // which is what proves the target mode — not the stored one — is what
      // the day is re-priced in.
      const it = mkItinerary("transit", leg(-1, "transit", 25));
      const before = venueIds(it);
      const res = await switchTravelMode(
        it,
        "driving",
        new Date(T(17, 0)),
        depsWithoutLegs()
      );
      assert.ok(res.switched, `expected a switch: ${JSON.stringify(res)}`);
      if (!res.switched) return;
      assert.strictEqual(res.from, "transit");
      assert.strictEqual(res.to, "driving");

      assert.strictEqual(it.travelMode, "driving");
      // THE LOAD-BEARING ASSERTION: same venues, same order, same names.
      assert.deepStrictEqual(venueIds(it), before);
      assert.deepStrictEqual(venueNames(it), [
        "Dinner Spot",
        "Bar Spot",
        "Dessert Spot",
      ]);

      const fresh = recomputedLegs(it);
      assert.ok(fresh.length > 0, "the switch re-priced at least one leg");
      for (const l of fresh) {
        // A DRIVING plan legitimately contains WALK legs (the short-leg
        // relabel), so the assertion is "never transit", not "always drive".
        assert.notStrictEqual(
          l.mode,
          "transit",
          "a leg re-priced for a driving plan must never come back transit"
        );
      }
      // ...and at least one of them is a genuine drive, so the case is not
      // passing on a plan that relabelled everything to walking.
      assert.ok(
        fresh.some((l) => l.mode === "driving"),
        `expected a real drive among ${fresh.map((l) => l.mode).join(", ")}`
      );
    },
  ],
  [
    "DRIVING → TRANSIT re-prices every leg ahead in the NEW mode, and every venue survives",
    async () => {
      const it = mkItinerary("driving", leg(-1, "driving", 25));
      const before = venueIds(it);
      const res = await switchTravelMode(
        it,
        "transit",
        new Date(T(17, 0)),
        depsWithoutLegs()
      );
      assert.ok(res.switched, `expected a switch: ${JSON.stringify(res)}`);
      if (!res.switched) return;
      assert.strictEqual(res.from, "driving");
      assert.strictEqual(res.to, "transit");

      assert.deepStrictEqual(venueIds(it), before);
      const fresh = recomputedLegs(it);
      assert.ok(fresh.length > 0, "the switch re-priced at least one leg");
      for (const l of fresh) {
        assert.notStrictEqual(
          l.mode,
          "driving",
          "a leg re-priced for a transit plan must never come back a drive"
        );
      }
      assert.ok(
        fresh.some((l) => l.mode === "transit"),
        `expected a real transit ride among ${fresh.map((l) => l.mode).join(", ")}`
      );
    },
  ],
  [
    "switching to TRANSIT removes the stored field — absent is what transit MEANS",
    async () => {
      // `Object.assign` copies keys and cannot remove one, so a delete on the
      // clone has to be replayed on the real object. Without that the plan
      // would still read as driving to every later mutation.
      const it = mkItinerary("driving", leg(-1, "driving", 25));
      const res = await switchTravelMode(
        it,
        "transit",
        new Date(T(17, 0)),
        depsWithoutLegs()
      );
      assert.ok(res.switched);
      assert.strictEqual(it.travelMode, undefined);
      assert.ok(
        !Object.prototype.hasOwnProperty.call(it, "travelMode"),
        "a transit plan must be byte-identical to a pre-drive-mode one"
      );
    },
  ],
  [
    "a plan with NO stored mode reads as transit and can be switched to driving",
    async () => {
      // Every plan stored before Stage 1 is in this state; none was migrated.
      const it = mkItinerary(undefined, leg(-1, "transit", 25));
      assert.strictEqual(it.travelMode, undefined, "fixture precondition");
      const res = await switchTravelMode(
        it,
        "driving",
        new Date(T(17, 0)),
        depsWithoutLegs()
      );
      assert.ok(res.switched, `expected a switch: ${JSON.stringify(res)}`);
      if (!res.switched) return;
      assert.strictEqual(res.from, "transit");
      assert.strictEqual(it.travelMode, "driving");
    },
  ],

  // ───────────────────────── the no-op ─────────────────────────
  [
    "NO-OP: switching to the mode the plan is already in changes nothing and spends nothing",
    async () => {
      const it = mkItinerary("driving", leg(-1, "driving", 25));
      const snapshot = JSON.stringify(it);
      let legs = 0;
      let weather = 0;
      const res = await switchTravelMode(it, "driving", new Date(T(17, 0)), {
        ...mkDeps(),
        getWeather: async () => {
          weather++;
          return null;
        },
        getSingleLeg: async () => {
          legs++;
          throw new Error("a no-op must not price a single leg");
        },
      });
      assert.ok(!res.switched, "a no-op is a refusal, so nothing is written");
      if (!res.switched) assert.match(res.reason, /already gets around by driving/i);
      assert.strictEqual(JSON.stringify(it), snapshot, "the plan is byte-identical");
      assert.strictEqual(legs, 0, "no route lookups");
      assert.strictEqual(weather, 0, "not even a forecast");
    },
  ],
  [
    "NO-OP: an ABSENT mode is transit, so switching to transit is also a no-op",
    async () => {
      const it = mkItinerary(undefined, leg(-1, "transit", 25));
      const snapshot = JSON.stringify(it);
      const res = await switchTravelMode(it, "transit", new Date(T(17, 0)), mkDeps());
      assert.ok(!res.switched);
      if (!res.switched) assert.match(res.reason, /already gets around by transit/i);
      assert.strictEqual(JSON.stringify(it), snapshot);
    },
  ],

  // ───────────────────────── the arithmetic ─────────────────────────
  [
    "the departure from home is HELD and the day re-times from the new leg",
    async () => {
      // A 25-minute home leg means the plan departs at 18:35 for a 19:00
      // dinner. Switching must hold that departure and re-price the leg: the
      // new 10-minute leg lands dinner at 18:45, not 19:00 + anything.
      const it = mkItinerary("transit", leg(-1, "transit", 25));
      const res = await switchTravelMode(
        it,
        "driving",
        new Date(T(17, 0)),
        mkDeps({ legMin: 10 })
      );
      assert.ok(res.switched, `expected a switch: ${JSON.stringify(res)}`);
      if (!res.switched) return;

      assert.strictEqual(ms(it.stops[0].start_time), ms(T(18, 45)));
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(20, 30)));
      // and the new home leg is the one that got them there
      assert.strictEqual(it.homeLeg?.totalMinutes, 10);
      assert.strictEqual(it.homeLeg?.encodedPolyline, "enc_new");

      // the tail follows: 20:30 + 10 = 20:40 (70 min) → 21:50 + 10 = 22:00
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(20, 40)));
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(22, 0)));
      assert.deepStrictEqual(venueIds(it), ["d1", "b1", "s1"]);
      assert.deepStrictEqual(res.shifted, [0, 1, 2]);
    },
  ],
  [
    "every leg the plan holds is re-priced, home leg included",
    async () => {
      const it = mkItinerary("transit", leg(-1, "transit", 25));
      const res = await switchTravelMode(
        it,
        "driving",
        new Date(T(17, 0)),
        mkDeps({ legMin: 10 })
      );
      assert.ok(res.switched);
      const stale = allLegs(it).filter((l) => l.encodedPolyline === "enc_stored");
      assert.deepStrictEqual(
        stale,
        [],
        "a leg still carrying the old polyline was never re-priced"
      );
      assert.strictEqual(it.legs.length, 2, "the leg projection followed the stops");
      for (const l of it.legs) assert.strictEqual(l.encodedPolyline, "enc_new");
    },
  ],

  // ───────────────────── THE LOAD-BEARING SAFETY PROPERTY ─────────────────
  [
    "CLAMP: a stop pulled before its venue opens starts AT its opening time — and keeps its venue",
    async () => {
      // Driving is faster, so the bar would be pulled from 21:00 to 20:40 —
      // twenty minutes before its door opens. The cascade reads that as
      // "unusable" and its ordinary answer is to REPLACE the venue. That is
      // the substitution this whole rule exists to forbid.
      const it = mkItinerary("transit", leg(-1, "transit", 25));
      it.stops[0].currentOpeningHours = openHours(17, 2);
      it.stops[1].currentOpeningHours = openHours(21, 2);
      it.stops[2].currentOpeningHours = openHours(17, 2);
      const searched: string[] = [];
      const selected: string[] = [];
      const res = await switchTravelMode(
        it,
        "driving",
        new Date(T(17, 0)),
        mkDeps({
          legMin: 10,
          onSearch: () => searched.push("searched"),
          onSelect: () => selected.push("selected"),
        })
      );
      assert.ok(res.switched, `expected a switch: ${JSON.stringify(res)}`);
      if (!res.switched) return;

      // THE LOAD-BEARING ASSERTION: same venues, same ids, same names.
      assert.deepStrictEqual(venueIds(it), ["d1", "b1", "s1"]);
      assert.strictEqual(it.stops[1].name, "Bar Spot");
      // ...and nothing was ever searched or selected, so it did not merely
      // happen to pick the same place back.
      assert.deepStrictEqual(searched, []);
      assert.deepStrictEqual(selected, []);

      // clamped to the opening minute: not 20:40, and not left at 21:00 by
      // refusing to move at all — the stop still gave up what it legally could.
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(21, 0)));
      assert.strictEqual(ms(it.stops[1].end_time), ms(T(22, 10)));
      // dinner still moved earlier, so the clamp is local to the bar
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(18, 45)));
      // and the stop behind the clamped one is re-timed off the CLAMPED end
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(22, 20)));
    },
  ],
  [
    "NEVER SUBSTITUTE: a stop pushed past its CLOSING time refuses instead of swapping the venue",
    async () => {
      // The other direction, which no clamp can reach: switching to a slower
      // mode pushes the dessert later, and the cascade's ordinary answer to a
      // shut venue is still `findReplacement`. It has to refuse.
      const it = mkItinerary("driving", leg(-1, "driving", 10));
      const snapshot = JSON.stringify(it);
      const searched: string[] = [];
      const res = await switchTravelMode(
        it,
        "transit",
        new Date(T(17, 0)),
        mkDeps({
          legMin: 45,
          unusableIds: ["s1"],
          onSearch: () => searched.push("searched"),
        })
      );
      assert.ok(!res.switched, `expected a refusal: ${JSON.stringify(res)}`);
      if (!res.switched) {
        assert.match(res.reason, /Couldn't switch to transit/i);
        assert.match(res.reason, /Dessert Spot/);
        assert.match(res.reason, /can't swap it for somewhere else/i);
      }
      // No search was spent looking for a replacement it would have rejected.
      assert.deepStrictEqual(searched, []);
      // ...and the refusal left the plan untouched, mode included.
      assert.strictEqual(JSON.stringify(it), snapshot);
      assert.strictEqual(it.travelMode, "driving");
    },
  ],
  [
    "a mode switch never asks the model or the Places API anything",
    async () => {
      const it = mkItinerary("transit", leg(-1, "transit", 25));
      let searched = 0;
      let selected = 0;
      let interpreted = 0;
      const res = await switchTravelMode(
        it,
        "driving",
        new Date(T(17, 0)),
        mkDeps({
          legMin: 10,
          onSearch: () => searched++,
          onSelect: () => selected++,
          onInterpret: () => interpreted++,
        })
      );
      assert.ok(res.switched, `expected a switch: ${JSON.stringify(res)}`);
      assert.strictEqual(searched, 0, "no Places search");
      assert.strictEqual(selected, 0, "no select call");
      assert.strictEqual(interpreted, 0, "no interpret call");
    },
  ],

  // ───────────────────────── the floor ─────────────────────────
  [
    "FLOOR: a locked/past stop is untouched and only what is AHEAD re-prices",
    async () => {
      // Mid-outing at 21:30: dinner is done and the bar is active, so the
      // first movable stop is the dessert. Its inbound leg is re-priced from
      // the bar's committed end; everything at or before the floor is history.
      const it = mkItinerary("transit", leg(-1, "transit", 25));
      const now = new Date(T(21, 30));
      withStatuses(it, now);
      assert.strictEqual(it.stops[0].status, "completed", "fixture precondition");
      assert.strictEqual(it.stops[1].status, "active", "fixture precondition");

      const res = await switchTravelMode(it, "driving", now, mkDeps({ legMin: 6 }));
      assert.ok(res.switched, `expected a switch: ${JSON.stringify(res)}`);
      if (!res.switched) return;

      // the two settled stops kept their committed times AND their legs
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(19, 0)));
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(20, 45)));
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(21, 0)));
      assert.strictEqual(it.homeLeg?.encodedPolyline, "enc_stored");
      assert.strictEqual(
        it.stops[0].travelToNext?.encodedPolyline,
        "enc_stored",
        "a leg already travelled must keep the mode it was travelled in"
      );

      // ...and only the leg still ahead was re-priced: 22:10 + 6 = 22:16
      assert.strictEqual(it.stops[1].travelToNext?.encodedPolyline, "enc_new");
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(22, 16)));
      assert.deepStrictEqual(res.shifted, [2]);
      assert.deepStrictEqual(venueIds(it), ["d1", "b1", "s1"]);
    },
  ],
  [
    "FLOOR: with nothing left ahead the switch refuses rather than rewriting history",
    async () => {
      const it = mkItinerary("transit", leg(-1, "transit", 25));
      const now = new Date(T(23, 30)); // the whole day is done
      const snapshot = JSON.stringify(it);
      const res = await switchTravelMode(it, "driving", now, mkDeps({ legMin: 10 }));
      assert.ok(!res.switched, `expected a refusal: ${JSON.stringify(res)}`);
      if (!res.switched) assert.match(res.reason, /nothing left to re-route/i);
      assert.strictEqual(JSON.stringify(it), snapshot);
    },
  ],
  [
    "FLOOR: a re-priced first stop can never land in the past",
    async () => {
      // 18:50 already, with a plan that departs 18:35. Holding the departure
      // would put dinner at 18:45 — five minutes ago. `now` wins.
      const it = mkItinerary("transit", leg(-1, "transit", 25));
      const res = await switchTravelMode(
        it,
        "driving",
        new Date(T(18, 50)),
        mkDeps({ legMin: 10 })
      );
      assert.ok(res.switched, `expected a switch: ${JSON.stringify(res)}`);
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(18, 50)));
    },
  ],

  // ───────────────────── plan-then-commit + refusals ─────────────────────
  [
    "PLAN THEN COMMIT: a failed route lookup leaves the itinerary byte-identical",
    async () => {
      const it = mkItinerary("transit", leg(-1, "transit", 25));
      const snapshot = JSON.stringify(it);
      const res = await switchTravelMode(
        it,
        "driving",
        new Date(T(17, 0)),
        mkDeps({ legFails: true })
      );
      assert.ok(!res.switched, `expected a refusal: ${JSON.stringify(res)}`);
      if (!res.switched) assert.match(res.reason, /couldn't be re-checked for driving/i);
      assert.strictEqual(JSON.stringify(it), snapshot, "empty diff");
      // still transit, which on a stored plan means the field is still absent
      assert.strictEqual(it.travelMode, undefined);
    },
  ],
  [
    "the ANCHOR itself refuses rather than being substituted when the new leg shuts it out",
    async () => {
      // A 3-hour leg from home lands dinner at 21:35, and the seam calls the
      // venue unusable then. The anchor's own check must refuse — the same
      // rule as the tail's, enforced at the one place `resettleTail` does not
      // reach.
      const it = mkItinerary("transit", leg(-1, "transit", 25));
      const snapshot = JSON.stringify(it);
      const res = await switchTravelMode(
        it,
        "driving",
        new Date(T(17, 0)),
        mkDeps({ legMin: 180, unusableIds: ["d1"] })
      );
      assert.ok(!res.switched, `expected a refusal: ${JSON.stringify(res)}`);
      if (!res.switched) {
        assert.match(res.reason, /Switching to driving would move Dinner Spot/i);
        assert.match(res.reason, /isn't open then/i);
      }
      assert.strictEqual(JSON.stringify(it), snapshot);
    },
  ],
  [
    "a stated end the re-timed day now runs past is NOTED, not asked about",
    async () => {
      // Switching to a slower mode pushes the day out. The plan is still
      // written — the user chose the mode — and the overrun is surfaced.
      const it = mkItinerary("driving", leg(-1, "driving", 10), T(23, 0));
      const res = await switchTravelMode(
        it,
        "transit",
        new Date(T(17, 0)),
        mkDeps({ legMin: 40 })
      );
      assert.ok(res.switched, `expected a switch: ${JSON.stringify(res)}`);
      if (!res.switched) return;
      assert.ok(res.endNote, `expected an end note: ${JSON.stringify(res)}`);
      assert.match(res.endNote!, /past the 11:00 PM you asked for/i);
    },
  ],
  [
    "a plan with NO stated end never invents one to warn about",
    async () => {
      const it = mkItinerary("driving", leg(-1, "driving", 10));
      const res = await switchTravelMode(
        it,
        "transit",
        new Date(T(17, 0)),
        mkDeps({ legMin: 40 })
      );
      assert.ok(res.switched, `expected a switch: ${JSON.stringify(res)}`);
      if (!res.switched) return;
      assert.strictEqual(res.endNote, undefined);
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
