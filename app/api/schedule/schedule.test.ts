// Unit tests for durations + scheduling (step 6a).
// Run with: npx tsx app/api/schedule/schedule.test.ts
import assert from "node:assert";
import { DURATION_TABLE, getDuration, resolveCategory } from "./durations";
import { buildSchedule, resolveStartTime } from "./schedule";

// Fixed "now": Friday 2026-07-03 13:20 local (EDT, -04:00).
const NOW = new Date(2026, 6, 3, 13, 20, 0);

const cases: Array<[string, () => void]> = [
  [
    "resolver: cuisine + free-vocab categories map to table keys",
    () => {
      assert.strictEqual(resolveCategory("ramen"), "restaurant");
      assert.strictEqual(resolveCategory("fine dining"), "restaurant");
      assert.strictEqual(resolveCategory("tacos"), "restaurant");
      assert.strictEqual(resolveCategory("cocktails"), "bar");
      assert.strictEqual(resolveCategory("pub"), "bar");
      assert.strictEqual(resolveCategory("coffee shop"), "coffee shop");
      assert.strictEqual(resolveCategory("matcha cafe"), "coffee shop");
      assert.strictEqual(resolveCategory("gelato"), "dessert");
      assert.strictEqual(resolveCategory("art gallery"), "museum");
      assert.strictEqual(resolveCategory("walk in the park"), "park");
      assert.strictEqual(resolveCategory("movie"), "movie");
    },
  ],
  [
    "resolver: unknown category → default",
    () => {
      assert.strictEqual(resolveCategory("axe throwing"), "default");
      assert.strictEqual(resolveCategory(""), "default");
    },
  ],
  [
    "duration math: resolved categories return the right table entries",
    () => {
      assert.deepStrictEqual(getDuration("ramen"), { baseMinutes: 90, bufferMinutes: 15 });
      assert.deepStrictEqual(getDuration("cocktails"), { baseMinutes: 60, bufferMinutes: 10 });
      assert.deepStrictEqual(getDuration("axe throwing"), DURATION_TABLE.default);
    },
  ],
  [
    "day-part defaults: evening → 19:00, tonight → 20:00 (same day)",
    () => {
      assert.strictEqual(
        resolveStartTime("evening", NOW).toISOString(),
        new Date(2026, 6, 3, 19, 0, 0).toISOString()
      );
      assert.strictEqual(
        resolveStartTime("tonight", NOW).toISOString(),
        new Date(2026, 6, 3, 20, 0, 0).toISOString()
      );
      assert.strictEqual(
        resolveStartTime("tomorrow morning", NOW).toISOString(),
        new Date(2026, 6, 4, 10, 0, 0).toISOString()
      );
    },
  ],
  [
    "day-part already past rolls to the NEXT day (morning asked at 13:20)",
    () => {
      // 10:00 today is already past at 13:20 → tomorrow 10:00
      assert.strictEqual(
        resolveStartTime("morning", NOW).toISOString(),
        new Date(2026, 6, 4, 10, 0, 0).toISOString()
      );
      // clock time already past rolls too: "6am" asked at 13:20
      assert.strictEqual(
        resolveStartTime("6am", NOW).toISOString(),
        new Date(2026, 6, 4, 6, 0, 0).toISOString()
      );
    },
  ],
  [
    "unspecified → next full hour from now (13:20 → 14:00)",
    () => {
      assert.strictEqual(
        resolveStartTime("unspecified", NOW).toISOString(),
        new Date(2026, 6, 3, 14, 0, 0).toISOString()
      );
    },
  ],
  [
    "clock-time path: 'tomorrow, 6am' → Saturday 06:00 via parseTargetTime",
    () => {
      assert.strictEqual(
        resolveStartTime("tomorrow, 6am", NOW).toISOString(),
        new Date(2026, 6, 4, 6, 0, 0).toISOString()
      );
      // bare duration numbers must NOT be mistaken for clock times
      assert.strictEqual(
        resolveStartTime("evening, 5 hours", NOW).toISOString(),
        new Date(2026, 6, 3, 19, 0, 0).toISOString()
      );
    },
  ],
  [
    "3-stop chain: sequential, non-overlapping, Toronto ISO, travel placeholder",
    () => {
      const { startISO, stops } = buildSchedule(
        [
          { category: "ramen", id: "r1", name: "Ramen Spot" },      // 90+15 = 105
          { category: "cocktails", id: "b1", name: "Cocktail Bar" }, // 60+10 = 70
          { category: "gelato", id: "d1", name: "Gelato Place" },    // 30+10 = 40
        ],
        "evening",
        NOW
      );
      assert.strictEqual(startISO, "2026-07-03T19:00:00-04:00");

      assert.strictEqual(stops[0].start_time, "2026-07-03T19:00:00-04:00");
      assert.strictEqual(stops[0].end_time, "2026-07-03T20:45:00-04:00");
      assert.strictEqual(stops[1].start_time, "2026-07-03T20:45:00-04:00");
      assert.strictEqual(stops[1].end_time, "2026-07-03T21:55:00-04:00");
      assert.strictEqual(stops[2].start_time, "2026-07-03T21:55:00-04:00");
      assert.strictEqual(stops[2].end_time, "2026-07-03T22:35:00-04:00");

      // sequential + non-overlapping with zero travel
      for (let i = 0; i < stops.length - 1; i++) {
        assert.strictEqual(stops[i].end_time, stops[i + 1].start_time);
        assert.strictEqual(stops[i].travelMinutesToNext, 0);
      }
      // last stop has no travel leg
      assert.strictEqual(stops[2].travelMinutesToNext, undefined);
      assert.deepStrictEqual(stops[0].durationMinutes, { base: 90, buffer: 15, total: 105 });
    },
  ],
  [
    "null-id selection passes through untimed without breaking the chain",
    () => {
      const { stops } = buildSchedule(
        [
          { category: "coffee shop", id: "c1", name: "Cafe" },
          { category: "bookstore", id: null, reason: "no venues survived filtering" },
        ],
        "morning",
        NOW
      );
      // "morning" at 13:20 rolls to tomorrow 10:00
      assert.strictEqual(stops[0].start_time, "2026-07-04T10:00:00-04:00");
      assert.strictEqual(stops[0].end_time, "2026-07-04T11:00:00-04:00");
      assert.strictEqual(stops[1].start_time, null);
      assert.strictEqual(stops[1].durationMinutes, null);
      // the only timed stop is also the last timed stop → no travel leg
      assert.strictEqual(stops[0].travelMinutesToNext, undefined);
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
