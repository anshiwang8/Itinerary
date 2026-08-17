// Remove-stop engine tests — the splice, the gap that closes behind it, the
// open-time clamp that stops the gap from costing a venue, and the four
// refusals. Pipeline deps are injected fakes; no network.
// Run with: npx tsx app/api/itinerary/removeStop.test.ts
import assert from "node:assert";
import { createItinerary, withStatuses, Itinerary } from "./store";
import { removeStop, LAST_STOP_MESSAGE } from "./removeStop";
import { SwapDeps } from "./swap";
import { Place, WeatherHour } from "../places/search/filter";
import { ScheduledStop } from "../schedule/schedule";
import type { CurrentOpeningHours } from "../places/search/hours";
import { TravelLeg } from "../schedule/travel";

const T = (h: number, m: number) =>
  `2026-07-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`;
const ms = (iso: string | null | undefined) => new Date(iso!).getTime();

function leg(fromIndex: number, mode: "transit" | "walk", total: number): TravelLeg {
  return {
    fromIndex,
    mode,
    rawMinutes: mode === "transit" ? total - 5 : total,
    marginMinutes: mode === "transit" ? 5 : 0,
    totalMinutes: total,
    distanceMeters: 1000,
    encodedPolyline: "enc_old",
  };
}

function transitMetadataLeg(
  fromIndex: number,
  total: number,
  legId: string,
  rideId: string,
  paletteSlot: number | null
): TravelLeg {
  const ride = {
    rideId,
    sourceStepIndex: 0,
    paletteSlot,
    lineName: "Test Line",
    shortName: "T",
    color: null,
    textColor: null,
    vehicle: "BUS",
    headsign: "Test Terminal",
    stopCount: 3,
    departStop: "Origin",
    arriveStop: "Destination",
  };
  return {
    ...leg(fromIndex, "transit", total),
    legId,
    transit: { ...ride },
    transitSegments: [{ ...ride }],
    pathSegments: [
      {
        mode: "transit",
        encodedPolyline: `path-${rideId}`,
        color: null,
        rideId,
        sourceStepIndex: 0,
        paletteSlot,
      },
    ],
  };
}

function assertRideSlot(route: TravelLeg, rideId: string, paletteSlot: number) {
  assert.strictEqual(route.transit?.rideId, rideId);
  assert.strictEqual(route.transit?.sourceStepIndex, 0);
  assert.strictEqual(route.transit?.paletteSlot, paletteSlot);
  assert.strictEqual(route.transitSegments?.[0]?.rideId, rideId);
  assert.strictEqual(route.transitSegments?.[0]?.sourceStepIndex, 0);
  assert.strictEqual(route.transitSegments?.[0]?.paletteSlot, paletteSlot);
  const path = route.pathSegments?.find((segment) => segment.mode === "transit");
  assert.strictEqual(path?.rideId, rideId);
  assert.strictEqual(path?.sourceStepIndex, 0);
  assert.strictEqual(path?.paletteSlot, paletteSlot);
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
      location: { latitude: 43.647, longitude: -79.42 },
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
      location: { latitude: 43.649, longitude: -79.41 },
      travelMinutesToNext: 10,
      travelToNext: leg(1, "walk", 10),
    },
    {
      category: "dessert",
      id: "s1",
      name: "Dessert Spot",
      start_time: T(22, 20),
      end_time: T(23, 0),
      durationMinutes: { base: 30, buffer: 10, total: 40 },
      location: { latitude: 43.65, longitude: -79.405 },
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
  // neither a city centre nor a home, so the fixture has to carry one for the
  // "refused before spending anything" assertions to mean anything. It changes
  // no outcome: the injected forecast is null by default, which is exactly the
  // keep-on-missing value the gate already had.
  cityCenter: { latitude: 43.6532, longitude: -79.3832 },
};

function mkItinerary(homeLeg?: TravelLeg | null) {
  return createItinerary(
    mkStops(),
    [leg(0, "transit", 15), leg(1, "walk", 10)],
    PARSED,
    homeLeg
  );
}

/** A two-stop plan: dinner 19:00–20:45 → bar 21:00–22:10. */
function mkTwoStop() {
  const stops = mkStops().slice(0, 2);
  delete stops[1].travelToNext;
  delete stops[1].travelMinutesToNext;
  return createItinerary(stops, [leg(0, "transit", 15)], PARSED);
}

/** A one-stop plan — the down-to-zero fixture. */
function mkOneStop() {
  const stops = mkStops().slice(0, 1);
  delete stops[0].travelToNext;
  delete stops[0].travelMinutesToNext;
  return createItinerary(stops, [], PARSED);
}

function mkVenue(id: string, name = `New ${id}`): Place {
  return {
    id,
    displayName: { text: name },
    rating: 4.5,
    businessStatus: "OPERATIONAL",
    location: { latitude: 43.651, longitude: -79.415 },
    editorialSummary: { text: `${name}, a real spot on the strip.` },
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
  /** fires when the forecast is fetched — the first thing a removal spends,
   *  and therefore the marker for "did we get past the cheap guards?" */
  onWeather?: () => void;
}

function mkDeps(opts: Opts = {}): SwapDeps {
  return {
    getWeather: async () => {
      opts.onWeather?.();
      return opts.weather ?? null;
    },
    interpret: async () => {
      throw new Error("removeStop must never ask the model to interpret anything");
    },
    searchPools: async (_parsed, cats) => {
      opts.onSearch?.();
      const key = cats[0];
      return { [key]: [mkVenue(`${key}_fresh`)] };
    },
    selectVenues: async (_parsed, pools) =>
      Object.entries(pools).map(([category, arr]) =>
        arr.length
          ? {
              category,
              id: arr[0].id,
              reason: `A fresh ${category} that fits.`,
              name: arr[0].displayName?.text,
              rating: arr[0].rating,
            }
          : { category, id: null, reason: "no venues survived filtering" }
      ),
    getSingleLeg: async (_o, _d, fromIndex) => {
      if (opts.legFails) throw new Error("routes unavailable");
      return {
        fromIndex,
        mode: "walk",
        rawMinutes: opts.legMin ?? 10,
        marginMinutes: 0,
        totalMinutes: opts.legMin ?? 10,
        distanceMeters: 700,
        encodedPolyline: "enc_new",
      };
    },
    isUsableAt: (place) => !(opts.unusableIds ?? []).includes(place.id),
  };
}

/** Every venue id still in the plan, in order — the "no silent substitution"
 *  assertion in one value. */
const venueIds = (it: Itinerary) => it.stops.map((s) => s.id);

const cases: Array<[string, () => Promise<void>]> = [
  [
    "MIDDLE: the tail slides earlier to close the gap, and no venue changes",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0)); // all upcoming
      const res = await removeStop(it, 1, now, mkDeps({ legMin: 10 }));
      assert.ok(res.removed, `expected a removal: ${JSON.stringify(res)}`);
      if (!res.removed) return;

      // the bar is gone; the other two venues are untouched
      assert.strictEqual(it.stops.length, 2);
      assert.deepStrictEqual(venueIds(it), ["d1", "s1"]);
      assert.strictEqual(res.before.name, "Bar Spot");

      // dinner did not move — a removal downstream of it changes nothing
      assert.strictEqual(it.stops[0].start_time, T(19, 0));
      assert.strictEqual(it.stops[0].end_time, T(20, 45));

      // THE GAP CLOSED: dessert was 22:20, now 20:45 + the real 10-min
      // bridging leg = 20:55, keeping its own 40-minute length
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(20, 55)));
      assert.strictEqual(ms(it.stops[1].end_time), ms(T(21, 35)));
      assert.strictEqual(it.stops[1].name, "Dessert Spot");
      assert.deepStrictEqual(res.downstreamShifted, [1]);

      // the bridging leg replaced dinner's old outbound
      assert.strictEqual(it.stops[0].travelToNext?.totalMinutes, 10);
      assert.strictEqual(it.stops[0].travelMinutesToNext, 10);
      assert.strictEqual(it.stops[0].travelToNext?.encodedPolyline, "enc_new");
      // and the plan's leg projection followed it
      assert.strictEqual(it.legs.length, 1);
      assert.strictEqual(it.legs[0].encodedPolyline, "enc_new");
    },
  ],
  [
    "MIDDLE: retained route metadata survives and the bridge gets a fresh identity and first free slot",
    async () => {
      const homeLeg = transitMetadataLeg(
        -1,
        20,
        "leg-remove-home-retained",
        "ride-remove-home-retained",
        0
      );
      const it = mkItinerary(homeLeg);
      const oldInbound = transitMetadataLeg(
        0,
        15,
        "leg-remove-inbound-old",
        "ride-remove-inbound-old",
        1
      );
      const oldOutbound = transitMetadataLeg(
        1,
        10,
        "leg-remove-outbound-old",
        "ride-remove-outbound-old",
        2
      );
      it.stops[0].travelToNext = oldInbound;
      it.stops[0].travelMinutesToNext = oldInbound.totalMinutes;
      it.stops[1].travelToNext = oldOutbound;
      it.stops[1].travelMinutesToNext = oldOutbound.totalMinutes;
      it.legs = [oldInbound, oldOutbound];

      const homeBefore = JSON.stringify(it.homeLeg);
      const deps: SwapDeps = {
        ...mkDeps({ legMin: 10 }),
        getSingleLeg: async (_origin, _destination, fromIndex) =>
          transitMetadataLeg(
            fromIndex,
            10,
            "leg-remove-bridge-fresh",
            "ride-remove-bridge-fresh",
            null
          ),
      };
      const result = await removeStop(it, 1, new Date(T(18, 0)), deps);
      assert.ok(result.removed);
      if (!result.removed) return;

      assert.strictEqual(JSON.stringify(it.homeLeg), homeBefore);
      assertRideSlot(it.homeLeg!, "ride-remove-home-retained", 0);
      const bridge = it.stops[0].travelToNext!;
      assert.strictEqual(bridge.legId, "leg-remove-bridge-fresh");
      assert.notStrictEqual(bridge.legId, oldInbound.legId);
      assert.notStrictEqual(bridge.legId, oldOutbound.legId);
      assertRideSlot(bridge, "ride-remove-bridge-fresh", 1);
      const slots = [
        it.homeLeg!.transit!.paletteSlot,
        it.legs[0].transit!.paletteSlot,
      ];
      assert.deepStrictEqual(slots, [0, 1]);
      assert.strictEqual(new Set(slots).size, slots.length);
    },
  ],
  [
    "CLAMP: a stop that would slide before it opens starts AT its opening time — and keeps its venue",
    async () => {
      // Dessert opens at 21:00. Closing the gap would put it at 20:55, five
      // minutes before the door opens — which the cascade would read as
      // "unusable" and answer by REPLACING it. That is the substitution this
      // whole rule exists to forbid.
      const it = mkItinerary();
      it.stops[2].currentOpeningHours = openHours(21, 2);
      const now = new Date(T(18, 0));
      const searched: string[] = [];
      const res = await removeStop(
        it,
        1,
        now,
        mkDeps({ legMin: 10, onSearch: () => searched.push("searched") })
      );
      assert.ok(res.removed, `expected a removal: ${JSON.stringify(res)}`);
      if (!res.removed) return;

      // THE LOAD-BEARING ASSERTION: same venue, same id, same name.
      assert.deepStrictEqual(venueIds(it), ["d1", "s1"]);
      assert.strictEqual(it.stops[1].name, "Dessert Spot");
      // ...and no re-search was ever attempted, so it did not merely happen to
      // pick the same place back
      assert.deepStrictEqual(searched, []);

      // clamped to the opening minute, not to 20:55 and not left at 22:20
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(21, 0)));
      assert.strictEqual(ms(it.stops[1].end_time), ms(T(21, 40)));
    },
  ],
  [
    "CLAMP: the clamp cascades — a clamped stop pushes the one behind it too",
    async () => {
      // Four stops, and the third opens late. The fourth must be re-timed off
      // the CLAMPED third, not off where the third would have landed.
      const stops = mkStops();
      stops[2].currentOpeningHours = openHours(21, 2);
      stops[2].travelToNext = leg(2, "walk", 10);
      stops[2].travelMinutesToNext = 10;
      stops.push({
        category: "bar",
        id: "n1",
        name: "Nightcap",
        start_time: T(23, 10),
        end_time: T(23, 50),
        durationMinutes: { base: 30, buffer: 10, total: 40 },
        location: { latitude: 43.652, longitude: -79.4 },
      });
      const it = createItinerary(stops, [], PARSED);
      const now = new Date(T(18, 0));
      const res = await removeStop(it, 1, now, mkDeps({ legMin: 10 }));
      assert.ok(res.removed, `expected a removal: ${JSON.stringify(res)}`);
      if (!res.removed) return;

      assert.deepStrictEqual(venueIds(it), ["d1", "s1", "n1"]);
      // dessert clamped to 21:00–21:40
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(21, 0)));
      // the nightcap follows the CLAMPED end, not the unclamped one
      assert.strictEqual(ms(it.stops[2].start_time), ms(T(21, 50)));
      assert.strictEqual(ms(it.stops[2].end_time), ms(T(22, 30)));
    },
  ],
  [
    "FIRST: the home leg re-targets the new first stop, and the day leaves home when it always did",
    async () => {
      // A 20-minute home leg means the plan departs at 18:40 for a 19:00
      // dinner. Removing dinner must hold that departure and re-price the leg
      // to the bar — arriving 18:40 + the real new leg, not 19:00 + anything.
      const it = mkItinerary(leg(-1, "transit", 20));
      const now = new Date(T(17, 0));
      const res = await removeStop(it, 0, now, mkDeps({ legMin: 10 }));
      assert.ok(res.removed, `expected a removal: ${JSON.stringify(res)}`);
      if (!res.removed) return;

      assert.deepStrictEqual(venueIds(it), ["b1", "s1"]);
      // the home leg was re-priced and re-aimed
      assert.strictEqual(it.homeLeg?.totalMinutes, 10);
      assert.strictEqual(it.homeLeg?.fromIndex, -1);
      assert.strictEqual(it.homeLeg?.encodedPolyline, "enc_new");

      // 18:40 departure + 10-min leg = 18:50, holding the bar's own 70 minutes
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(18, 50)));
      assert.strictEqual(ms(it.stops[0].end_time), ms(T(20, 0)));
      // and the tail followed it
      assert.strictEqual(ms(it.stops[1].start_time), ms(T(20, 10)));
      assert.strictEqual(ms(it.stops[1].end_time), ms(T(20, 50)));
      assert.deepStrictEqual(res.downstreamShifted, [0, 1]);
    },
  ],
  [
    "FIRST: with no stored home leg the departure is the removed stop's own start",
    async () => {
      // A pre-home-leg plan has nothing to subtract, so `homeDeparture` falls
      // back to the anchor's start. The removal must still work rather than
      // producing an invalid instant.
      const it = mkItinerary();
      const now = new Date(T(17, 0));
      const res = await removeStop(it, 0, now, mkDeps({ legMin: 10 }));
      assert.ok(res.removed, `expected a removal: ${JSON.stringify(res)}`);
      if (!res.removed) return;
      // departs 19:00 (dinner's start), + 10 = 19:10
      assert.strictEqual(ms(it.stops[0].start_time), ms(T(19, 10)));
      assert.strictEqual(it.homeLeg?.totalMinutes, 10);
    },
  ],
  [
    "LAST: the plan ends earlier and the new last stop has NO dangling leg",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      const res = await removeStop(it, 2, now, mkDeps({ legMin: 10 }));
      assert.ok(res.removed, `expected a removal: ${JSON.stringify(res)}`);
      if (!res.removed) return;

      assert.deepStrictEqual(venueIds(it), ["d1", "b1"]);
      // nothing upstream moved — there was no gap in front of anything
      assert.strictEqual(it.stops[0].start_time, T(19, 0));
      assert.strictEqual(it.stops[1].start_time, T(21, 0));
      assert.strictEqual(it.stops[1].end_time, T(22, 10));
      assert.deepStrictEqual(res.downstreamShifted, []);

      // THE DANGLING LEG: the bar used to travel to the dessert. That leg
      // must be gone, or the strip draws a journey to nothing.
      assert.strictEqual(it.stops[1].travelToNext, undefined);
      assert.strictEqual(it.stops[1].travelMinutesToNext, undefined);
      assert.strictEqual(it.legs.length, 1);
      assert.strictEqual(it.legs[0].fromIndex, 0);
    },
  ],
  [
    "DOWN TO ONE is allowed",
    async () => {
      const it = mkTwoStop();
      const now = new Date(T(18, 0));
      const res = await removeStop(it, 1, now, mkDeps({ legMin: 10 }));
      assert.ok(res.removed, `expected a removal: ${JSON.stringify(res)}`);
      assert.strictEqual(it.stops.length, 1);
      assert.deepStrictEqual(venueIds(it), ["d1"]);
      // the survivor is now last, so it carries no outbound leg
      assert.strictEqual(it.stops[0].travelToNext, undefined);
      assert.strictEqual(it.legs.length, 0);
    },
  ],
  [
    "DOWN TO ZERO is REFUSED, and points at End rather than emptying the plan",
    async () => {
      const it = mkOneStop();
      const before = JSON.stringify(it);
      const now = new Date(T(18, 0));
      // The guard is asserted by its COST, not only by its message. Emptying
      // the plan is caught a second time further down (`reanchorOnHome` has no
      // first stop to anchor to and refuses with the same words), so a test
      // that only reads the reason passes with the guard deleted — which is
      // exactly what the revert-run showed. What separates them is that the
      // guard fires BEFORE the forecast is fetched and before anything is
      // spliced: it is a rule about the plan, not a dead end discovered late.
      let weatherFetched = 0;
      const res = await removeStop(
        it,
        0,
        now,
        mkDeps({ onWeather: () => (weatherFetched += 1) })
      );
      assert.ok(!res.removed, "removing the only stop must refuse");
      if (res.removed) return;
      assert.strictEqual(res.reason, LAST_STOP_MESSAGE);
      assert.match(res.reason, /End/);
      assert.strictEqual(
        weatherFetched,
        0,
        "the last-stop guard must refuse before spending a forecast call"
      );
      // an empty stops array reads as "completed" — nothing may be written
      assert.strictEqual(JSON.stringify(it), before);
      assert.strictEqual(it.stops.length, 1);
    },
  ],
  [
    "DOWN TO ZERO counts only stops with a venue — skipped slots don't rescue it",
    async () => {
      // A weather-blocked slot has no venue and no times. It is still an entry
      // in `stops`, so a naive length check would let the last real stop go —
      // and a plan of nothing but skipped slots reads as completed too.
      const stops = mkStops().slice(0, 1);
      delete stops[0].travelToNext;
      delete stops[0].travelMinutesToNext;
      const it = createItinerary(
        [
          ...stops,
          {
            category: "park",
            id: null,
            name: undefined,
            reason: "rained out",
            start_time: null,
            end_time: null,
            durationMinutes: null,
          } as ScheduledStop,
        ],
        [],
        PARSED
      );
      const before = JSON.stringify(it);
      let weatherFetched = 0;
      const res = await removeStop(
        it,
        0,
        new Date(T(18, 0)),
        mkDeps({ onWeather: () => (weatherFetched += 1) })
      );
      assert.ok(!res.removed, "the last VENUE stop must refuse even beside a skipped slot");
      if (res.removed) return;
      assert.strictEqual(res.reason, LAST_STOP_MESSAGE);
      assert.strictEqual(weatherFetched, 0, "refused before spending a forecast call");
      assert.strictEqual(JSON.stringify(it), before);
    },
  ],
  [
    "PAST/ACTIVE stop is REFUSED with the reason named",
    async () => {
      const it = mkItinerary();
      const now = new Date(T(19, 30)); // mid-dinner
      withStatuses(it, now);
      assert.strictEqual(it.stops[0].locked, true);
      const before = JSON.stringify(it);
      const res = await removeStop(it, 0, now, mkDeps());
      assert.ok(!res.removed, "an active stop must refuse");
      if (res.removed) return;
      assert.match(res.reason, /already underway or done/i);
      assert.match(res.reason, /Dinner Spot/);
      assert.strictEqual(JSON.stringify(it), before);
    },
  ],
  [
    "LOCKED stop is REFUSED even when its time is still in the future",
    async () => {
      // The ratchet outlives the clock: a stop that has been active stays
      // locked through a dev time-rewind, and a locked stop is user-pinned.
      const it = mkItinerary();
      it.stops[1].locked = true;
      const now = new Date(T(18, 0)); // the bar is upcoming by the clock
      const before = JSON.stringify(it);
      const res = await removeStop(it, 1, now, mkDeps());
      assert.ok(!res.removed, "a locked stop must refuse");
      if (res.removed) return;
      assert.match(res.reason, /already underway or done/i);
      assert.strictEqual(JSON.stringify(it), before);
    },
  ],
  [
    "PLAN-THEN-COMMIT: a failed re-settle leaves the itinerary byte-identical",
    async () => {
      const it = mkItinerary();
      const before = JSON.stringify(it);
      const now = new Date(T(18, 0));
      // every route lookup throws → the bridging leg can't be verified
      const res = await removeStop(it, 1, now, mkDeps({ legFails: true }));
      assert.ok(!res.removed, "an unverifiable route must refuse");
      if (res.removed) return;
      assert.match(res.reason, /couldn't be verified/i);
      // THE EMPTY DIFF: the splice happened on a clone and never landed
      assert.strictEqual(JSON.stringify(it), before);
      assert.strictEqual(it.stops.length, 3);
      assert.deepStrictEqual(venueIds(it), ["d1", "b1", "s1"]);
    },
  ],
  [
    "PLAN-THEN-COMMIT: a failed FIRST-stop re-anchor leaves the itinerary byte-identical",
    async () => {
      const it = mkItinerary(leg(-1, "transit", 20));
      const before = JSON.stringify(it);
      const res = await removeStop(it, 0, new Date(T(17, 0)), mkDeps({ legFails: true }));
      assert.ok(!res.removed, "an unverifiable home leg must refuse");
      if (res.removed) return;
      assert.strictEqual(JSON.stringify(it), before);
      assert.strictEqual(it.homeLeg?.totalMinutes, 20);
    },
  ],
  [
    "a LOCKED downstream stop keeps its committed time and terminates the cascade",
    async () => {
      const it = mkItinerary();
      it.stops[2].locked = true; // dessert pinned at 22:20
      const now = new Date(T(18, 0));
      const res = await removeStop(it, 1, now, mkDeps({ legMin: 10 }));
      assert.ok(res.removed, `expected a removal: ${JSON.stringify(res)}`);
      if (!res.removed) return;
      // the gap does NOT close onto a pinned stop
      assert.strictEqual(it.stops[1].start_time, T(22, 20));
      assert.strictEqual(it.stops[1].end_time, T(23, 0));
      assert.strictEqual(it.stops[1].locked, true);
      assert.deepStrictEqual(res.downstreamShifted, []);
      // the bridging leg to it is still committed
      assert.strictEqual(it.stops[0].travelToNext?.totalMinutes, 10);
    },
  ],
  [
    "a downstream venue that genuinely shuts is still adapted — the clamp is not a gag",
    async () => {
      // The clamp protects a stop the removal pulls EARLIER. A venue the
      // availability seam calls unusable at BOTH ends of that window is a real
      // problem, and the existing ladder must still answer it.
      const it = mkItinerary();
      const now = new Date(T(18, 0));
      const res = await removeStop(
        it,
        1,
        now,
        mkDeps({ legMin: 10, unusableIds: ["s1"] })
      );
      assert.ok(res.removed, `expected a removal: ${JSON.stringify(res)}`);
      if (!res.removed) return;
      assert.strictEqual(it.stops[1].id, "dessert_fresh");
      assert.strictEqual(it.stops[1].name, "New dessert_fresh");
    },
  ],
  [
    "the removed venue is never handed back as a downstream replacement",
    async () => {
      // Removing a stop and then being given it again a slot later is the
      // worst possible answer to "remove this".
      const it = mkItinerary();
      it.stops[2].category = "bar"; // same kind as the stop being removed
      const now = new Date(T(18, 0));
      const seen: Record<string, Place[]>[] = [];
      const deps: SwapDeps = {
        ...mkDeps({ legMin: 10, unusableIds: ["s1"] }),
        searchPools: async (_p, cats) => ({
          [cats[0]]: [
            { ...mkVenue("b1", "Bar Spot"), location: it.stops[1].location },
            mkVenue("other_bar"),
          ],
        }),
        selectVenues: async (_p, pools) => {
          seen.push(pools);
          return Object.entries(pools).map(([category, arr]) => ({
            category,
            id: arr[0]?.id ?? null,
            reason: "fits",
          }));
        },
      };
      const res = await removeStop(it, 1, now, deps);
      assert.ok(res.removed, `expected a removal: ${JSON.stringify(res)}`);
      // the removed venue never even reached the selector
      const offered = seen.flatMap((pools) => Object.values(pools).flat().map((p) => p.id));
      assert.ok(!offered.includes("b1"), `b1 was offered back: ${offered.join(", ")}`);
      assert.strictEqual(it.stops[1].id, "other_bar");
    },
  ],
  [
    "a nonexistent index and a venue-less slot both refuse without touching the plan",
    async () => {
      const it = mkItinerary();
      const before = JSON.stringify(it);
      const now = new Date(T(18, 0));

      const missing = await removeStop(it, 9, now, mkDeps());
      assert.ok(!missing.removed);
      if (!missing.removed) assert.match(missing.reason, /doesn't exist/i);

      it.stops[1].id = null;
      const noVenue = await removeStop(it, 1, now, mkDeps());
      assert.ok(!noVenue.removed);
      if (!noVenue.removed) assert.match(noVenue.reason, /no venue/i);

      it.stops[1].id = "b1";
      assert.strictEqual(JSON.stringify(it), before);
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
