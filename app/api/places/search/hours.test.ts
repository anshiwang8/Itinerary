// Tests for THE openness check — the shared zone-aware helper every caller
// (objective filter, swap availability seam, mock fixtures) now goes through.
//
// Fixtures are EXPLICIT absolute instants (ISO with offset / Z), so every
// assertion holds under ANY runner TZ. That matters more here than anywhere
// else in the repo: the bug this suite pins (code-audit 2026-07-18 §1.1) WAS
// "the server's local clock leaked into the verdict", so a test that only
// passes on a Toronto dev box would be worthless. Run both ways:
//   npx tsx app/api/places/search/hours.test.ts
//   TZ=UTC npx tsx app/api/places/search/hours.test.ts
import assert from "node:assert";
import {
  CurrentOpeningHours,
  isOpenAt,
  isOpenAtInstant,
  parseTargetTime,
  targetTimeAt,
} from "./hours";

// Mon–Sun 09:00–17:00 local.
const NINE_TO_FIVE: CurrentOpeningHours = {
  periods: Array.from({ length: 7 }, (_, day) => ({
    open: { day, hour: 9, minute: 0 },
    close: { day, hour: 17, minute: 0 },
  })),
};

// Monday ONLY, 20:00–22:00 local — isolates the day-of-week half of the bug.
const MONDAY_NIGHT: CurrentOpeningHours = {
  periods: [{ open: { day: 1, hour: 20, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }],
};

const cases: Array<[string, () => void]> = [
  [
    "targetTimeAt: one instant is a different day/hour per zone",
    () => {
      // 2026-07-07 03:30 UTC = Mon 20:30 Vancouver = Mon 23:30 Toronto = TUE 03:30 UTC
      const inst = new Date("2026-07-07T03:30:00Z");
      assert.deepStrictEqual(targetTimeAt(inst, "America/Vancouver"), { day: 1, hour: 20, minute: 30 });
      assert.deepStrictEqual(targetTimeAt(inst, "America/Toronto"), { day: 1, hour: 23, minute: 30 });
      assert.deepStrictEqual(targetTimeAt(inst, "UTC"), { day: 2, hour: 3, minute: 30 });
    },
  ],
  [
    "REGRESSION (§1.1): the verdict follows the PLAN's zone, not the server's",
    () => {
      // 23:30 UTC = 16:30 Vancouver (OPEN) but 19:30 Toronto / 23:30 UTC (CLOSED).
      // Pre-fix this was judged on the server's clock, so it returned false on a
      // Toronto dev box AND on a UTC serverless runtime — for a venue that is open.
      const inst = new Date("2026-07-06T23:30:00Z");
      assert.strictEqual(isOpenAtInstant(NINE_TO_FIVE, inst, "America/Vancouver"), true);
      assert.strictEqual(isOpenAtInstant(NINE_TO_FIVE, inst, "America/Toronto"), false);
      assert.strictEqual(isOpenAtInstant(NINE_TO_FIVE, inst, "UTC"), false);
    },
  ],
  [
    "REGRESSION (§1.1): the WEEKDAY follows the plan's zone too",
    () => {
      // Mon 20:30 in Vancouver is already TUESDAY in UTC — a venue open only on
      // Monday night must still read open for a Vancouver plan.
      const inst = new Date("2026-07-07T03:30:00Z");
      assert.strictEqual(isOpenAtInstant(MONDAY_NIGHT, inst, "America/Vancouver"), true);
      assert.strictEqual(isOpenAtInstant(MONDAY_NIGHT, inst, "UTC"), false);
    },
  ],
  [
    "keep-on-missing survives the wrapper: no data → null, never false",
    () => {
      const inst = new Date("2026-07-06T23:30:00Z");
      assert.strictEqual(isOpenAtInstant(undefined, inst, "America/Toronto"), null);
      assert.strictEqual(isOpenAtInstant(null, inst, "America/Toronto"), null);
      assert.strictEqual(isOpenAtInstant({ periods: [] }, inst, "America/Toronto"), null);
    },
  ],
  [
    "isOpenAtInstant is exactly isOpenAt ∘ targetTimeAt (one implementation)",
    () => {
      const inst = new Date("2026-07-07T03:30:00Z");
      for (const zone of ["America/Toronto", "America/Vancouver", "UTC", "Asia/Tokyo"]) {
        assert.strictEqual(
          isOpenAtInstant(NINE_TO_FIVE, inst, zone),
          isOpenAt(NINE_TO_FIVE, targetTimeAt(inst, zone)),
          `diverged for ${zone}`
        );
      }
    },
  ],
  [
    "default zone is Toronto (pre-multi-city callers unchanged)",
    () => {
      const inst = new Date("2026-07-06T18:00:00Z"); // 14:00 Toronto
      assert.strictEqual(isOpenAtInstant(NINE_TO_FIVE, inst), true);
      assert.deepStrictEqual(targetTimeAt(inst), { day: 1, hour: 14, minute: 0 });
    },
  ],
  [
    "parseTargetTime: clock times extracted, bare durations refused",
    () => {
      assert.deepStrictEqual(parseTargetTime("6am"), { hour: 6, minute: 0 });
      assert.deepStrictEqual(parseTargetTime("tomorrow, 6am"), { hour: 6, minute: 0 });
      assert.deepStrictEqual(parseTargetTime("7:15pm"), { hour: 19, minute: 15 });
      assert.deepStrictEqual(parseTargetTime("around 3:30"), { hour: 3, minute: 30 });
      assert.deepStrictEqual(parseTargetTime("12am"), { hour: 0, minute: 0 });
      assert.deepStrictEqual(parseTargetTime("12pm"), { hour: 12, minute: 0 });
      // no clock time at all
      assert.strictEqual(parseTargetTime("morning"), null);
      assert.strictEqual(parseTargetTime("evening, 5 hours"), null);
      assert.strictEqual(parseTargetTime("unspecified"), null);
    },
  ],
  [
    "parseTargetTime carries NO day field (§1.2 — the server-local trap is gone)",
    () => {
      // The whole point: nothing here can be computed from the server's clock,
      // because there is nothing date-shaped left to compute.
      assert.deepStrictEqual(Object.keys(parseTargetTime("6am")!).sort(), ["hour", "minute"]);
      // and "tomorrow" no longer changes the result — the resolver owns day math
      assert.deepStrictEqual(parseTargetTime("tomorrow, 6am"), parseTargetTime("6am"));
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
