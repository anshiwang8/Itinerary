// Unit tests for the date-aware UI labels.
// Run with: npx tsx app/lib/timeLabels.test.ts
import assert from "node:assert";
import { datePrefix, formatStopRange, formatStopTime } from "./timeLabels";

// Reference "now": Sun 2026-07-05 13:20 local. Local-date math, so build
// the fixtures with local Date components too.
const REF = new Date(2026, 6, 5, 13, 20, 0);
const local = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo, d, h, mi, 0);

const cases: Array<[string, () => void]> = [
  [
    "same-day stop → no date prefix (time only)",
    () => {
      // dinner today 7:00–8:45 PM
      assert.strictEqual(datePrefix(local(2026, 6, 5, 19, 0), REF), "");
      assert.strictEqual(
        formatStopRange(local(2026, 6, 5, 19, 0), local(2026, 6, 5, 20, 45), REF),
        "7:00 PM – 8:45 PM"
      );
    },
  ],
  [
    "rolled to tomorrow → 'tomorrow, ' prefix (brunch tomorrow 10:30)",
    () => {
      assert.strictEqual(datePrefix(local(2026, 6, 6, 10, 30), REF), "tomorrow, ");
      assert.strictEqual(
        formatStopRange(local(2026, 6, 6, 10, 30), local(2026, 6, 6, 11, 45), REF),
        "tomorrow, 10:30 AM – 11:45 AM"
      );
    },
  ],
  [
    "two+ days out → short date 'Sat Jul 11'",
    () => {
      assert.strictEqual(datePrefix(local(2026, 6, 11, 10, 30), REF), "Sat Jul 11, ");
      assert.strictEqual(
        formatStopTime(local(2026, 6, 11, 10, 30), REF),
        "Sat Jul 11, 10:30 AM"
      );
    },
  ],
  [
    "schedule crossing midnight: date only on post-midnight stops",
    () => {
      // late stop starts 11:30 PM today, ends 12:20 AM tomorrow: its
      // START is today → time-only (straddling midnight doesn't count)
      assert.strictEqual(
        formatStopRange(local(2026, 6, 5, 23, 30), local(2026, 6, 6, 0, 20), REF),
        "11:30 PM – 12:20 AM"
      );
      // the NEXT stop starts 12:40 AM tomorrow → shows "tomorrow"
      assert.strictEqual(
        formatStopRange(local(2026, 6, 6, 0, 40), local(2026, 6, 6, 1, 20), REF),
        "tomorrow, 12:40 AM – 1:20 AM"
      );
    },
  ],
  [
    "formatStopTime for a single labeled time (floor / leave-home)",
    () => {
      assert.strictEqual(formatStopTime(local(2026, 6, 5, 18, 30), REF), "6:30 PM");
      assert.strictEqual(
        formatStopTime(local(2026, 6, 6, 9, 58), REF),
        "tomorrow, 9:58 AM"
      );
    },
  ],
  [
    "accepts ISO strings too (round-trips the instant)",
    () => {
      const iso = local(2026, 6, 6, 10, 30).toISOString();
      assert.strictEqual(datePrefix(iso, REF), "tomorrow, ");
    },
  ],
  [
    "a past instant is treated as today (no negative-day prefix)",
    () => {
      assert.strictEqual(datePrefix(local(2026, 6, 4, 10, 0), REF), "");
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
