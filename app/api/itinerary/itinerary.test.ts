// Unit tests for itinerary state: status derivation boundaries, the
// locked ratchet, skipped exclusion, full lifecycle.
// Run with: npx tsx app/api/itinerary/itinerary.test.ts
import assert from "node:assert";
import { createItinerary, deriveStopStatus, withStatuses } from "./store";
import { ScheduledStop } from "../schedule/schedule";
import { TravelLeg } from "../schedule/travel";

function mkStop(
  category: string,
  start: string | null,
  end: string | null,
  id: string | null = category
): ScheduledStop {
  return {
    category,
    id,
    name: id ? `Venue ${id}` : undefined,
    start_time: start,
    end_time: end,
    durationMinutes: start && end ? { base: 60, buffer: 10, total: 70 } : null,
  };
}

// the familiar 3-stop chain: 19:00–20:45, 20:45–21:55, 21:55–22:35 EDT
const S1 = { start: "2026-07-03T19:00:00-04:00", end: "2026-07-03T20:45:00-04:00" };
const S2 = { start: "2026-07-03T20:45:00-04:00", end: "2026-07-03T21:55:00-04:00" };
const S3 = { start: "2026-07-03T21:55:00-04:00", end: "2026-07-03T22:35:00-04:00" };

const at = (iso: string) => new Date(iso);

const cases: Array<[string, () => void]> = [
  [
    "MULTI-CITY: createItinerary persists a per-plan home; absent stays absent",
    () => {
      const home = { label: "Start · 800 Robson St", location: { latitude: 49.2827, longitude: -123.1207 } };
      const withHome = createItinerary([mkStop("dinner", S1.start, S1.end)], [], undefined, null, home);
      assert.deepStrictEqual(withHome.home, home);
      const without = createItinerary([mkStop("dinner", S1.start, S1.end)], []);
      assert.strictEqual(without.home, undefined); // engines fall back to HOME
    },
  ],
  [
    "status derivation at exact boundaries: t == start → active, t == end → completed",
    () => {
      assert.strictEqual(deriveStopStatus(S1.start, S1.end, at("2026-07-03T18:59:59-04:00")), "upcoming");
      assert.strictEqual(deriveStopStatus(S1.start, S1.end, at(S1.start)), "active");
      assert.strictEqual(deriveStopStatus(S1.start, S1.end, at("2026-07-03T20:44:59-04:00")), "active");
      assert.strictEqual(deriveStopStatus(S1.start, S1.end, at(S1.end)), "completed");
      // null times can't progress
      assert.strictEqual(deriveStopStatus(null, null, at(S1.start)), "skipped");
    },
  ],
  [
    "locked ratchets on first activation, survives completion AND time rewind",
    () => {
      const it = createItinerary([mkStop("dinner", S1.start, S1.end)], []);
      // before start: not locked
      withStatuses(it, at("2026-07-03T18:00:00-04:00"));
      assert.strictEqual(it.stops[0].status, "upcoming");
      assert.strictEqual(it.stops[0].locked, false);
      // during: active + locked
      withStatuses(it, at("2026-07-03T19:30:00-04:00"));
      assert.strictEqual(it.stops[0].status, "active");
      assert.strictEqual(it.stops[0].locked, true);
      // dev time rewinds: status recomputes to upcoming, locked stays
      withStatuses(it, at("2026-07-03T18:00:00-04:00"));
      assert.strictEqual(it.stops[0].status, "upcoming");
      assert.strictEqual(it.stops[0].locked, true);
      // after end: completed, still locked
      withStatuses(it, at("2026-07-03T23:00:00-04:00"));
      assert.strictEqual(it.stops[0].status, "completed");
      assert.strictEqual(it.stops[0].locked, true);
    },
  ],
  [
    "skipped stops are excluded from itinerary-completion logic",
    () => {
      // null-id stop is skipped at creation
      const it = createItinerary(
        [mkStop("dinner", S1.start, S1.end), mkStop("park", null, null, null)],
        []
      );
      assert.strictEqual(it.stops[1].status, "skipped");
      // dinner still upcoming → itinerary active (skipped doesn't block)
      withStatuses(it, at("2026-07-03T18:00:00-04:00"));
      assert.strictEqual(it.status, "active");
      // dinner completed → itinerary completed even though park never ran
      withStatuses(it, at("2026-07-03T23:00:00-04:00"));
      assert.strictEqual(it.status, "completed");
      assert.strictEqual(it.stops[1].status, "skipped");
      assert.strictEqual(it.stops[1].locked, false); // skipped never locks
    },
  ],
  [
    "full 3-stop lifecycle at 5 simulated times",
    () => {
      const it = createItinerary(
        [
          mkStop("dinner", S1.start, S1.end, "d1"),
          mkStop("bar", S2.start, S2.end, "b1"),
          mkStop("dessert", S3.start, S3.end, "ds1"),
        ],
        []
      );
      const snapshot = (iso: string) => {
        withStatuses(it, at(iso));
        return {
          statuses: it.stops.map((s) => s.status),
          locked: it.stops.map((s) => s.locked),
          itinerary: it.status,
        };
      };

      // 1. before stop 1
      assert.deepStrictEqual(snapshot("2026-07-03T18:30:00-04:00"), {
        statuses: ["upcoming", "upcoming", "upcoming"],
        locked: [false, false, false],
        itinerary: "active",
      });
      // 2. during stop 1
      assert.deepStrictEqual(snapshot("2026-07-03T19:30:00-04:00"), {
        statuses: ["active", "upcoming", "upcoming"],
        locked: [true, false, false],
        itinerary: "active",
      });
      // 3. during stop 2
      assert.deepStrictEqual(snapshot("2026-07-03T21:00:00-04:00"), {
        statuses: ["completed", "active", "upcoming"],
        locked: [true, true, false],
        itinerary: "active",
      });
      // 4. during stop 3
      assert.deepStrictEqual(snapshot("2026-07-03T22:00:00-04:00"), {
        statuses: ["completed", "completed", "active"],
        locked: [true, true, true],
        itinerary: "active",
      });
      // 5. after stop 3
      assert.deepStrictEqual(snapshot("2026-07-03T23:00:00-04:00"), {
        statuses: ["completed", "completed", "completed"],
        locked: [true, true, true],
        itinerary: "completed",
      });
    },
  ],
  [
    "home leg is origin metadata: excluded from stop count, statuses, and completion",
    () => {
      const homeLeg: TravelLeg = {
        fromIndex: -1,
        mode: "transit",
        rawMinutes: 27,
        marginMinutes: 5,
        totalMinutes: 32,
        distanceMeters: 5200,
        encodedPolyline: "enc_home",
      };
      const it = createItinerary(
        [mkStop("dinner", S1.start, S1.end)],
        [],
        undefined,
        homeLeg
      );
      // home is NOT a stop — stop count is the real stops only
      assert.strictEqual(it.stops.length, 1);
      assert.deepStrictEqual(it.homeLeg, homeLeg);
      // completion is a function of real stops; home can't hold it open
      withStatuses(it, at("2026-07-03T23:00:00-04:00"));
      assert.strictEqual(it.status, "completed");
      // status derivation bolts nothing onto the home leg — untouched
      assert.deepStrictEqual(it.homeLeg, homeLeg);
    },
  ],
];

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
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
