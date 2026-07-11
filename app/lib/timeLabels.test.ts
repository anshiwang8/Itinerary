// Unit tests for the date-aware UI labels. Labels must render in the
// plan's home timezone (America/Toronto) regardless of the RUNNER's TZ —
// run this suite BOTH ways to prove it:
//   npx tsx app/lib/timeLabels.test.ts
//   TZ=UTC npx tsx app/lib/timeLabels.test.ts   (simulates a remote viewer)
import assert from "node:assert";
import { datePrefix, formatStopRange, formatStopTime } from "./timeLabels";

// Fixtures are EXPLICIT EDT instants (not runner-local Dates), so the
// expectations below hold under any runner timezone.
const pad = (n: number) => String(n).padStart(2, "0");
const edt = (mo: number, d: number, h: number, mi: number) =>
  new Date(`2026-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00-04:00`);

// Reference "now": Sun 2026-07-05 13:20 EDT.
const REF = edt(7, 5, 13, 20);

const cases: Array<[string, () => void]> = [
  [
    "same-day stop → no date prefix (time only)",
    () => {
      // dinner today 7:00–8:45 PM
      assert.strictEqual(datePrefix(edt(7, 5, 19, 0), REF), "");
      assert.strictEqual(
        formatStopRange(edt(7, 5, 19, 0), edt(7, 5, 20, 45), REF),
        "7:00 PM – 8:45 PM"
      );
    },
  ],
  [
    "rolled to tomorrow → 'tomorrow, ' prefix (brunch tomorrow 10:30)",
    () => {
      assert.strictEqual(datePrefix(edt(7, 6, 10, 30), REF), "tomorrow, ");
      assert.strictEqual(
        formatStopRange(edt(7, 6, 10, 30), edt(7, 6, 11, 45), REF),
        "tomorrow, 10:30 AM – 11:45 AM"
      );
    },
  ],
  [
    "two+ days out → short date 'Sat Jul 11'",
    () => {
      assert.strictEqual(datePrefix(edt(7, 11, 10, 30), REF), "Sat Jul 11, ");
      assert.strictEqual(formatStopTime(edt(7, 11, 10, 30), REF), "Sat Jul 11, 10:30 AM");
    },
  ],
  [
    "schedule crossing midnight: date only on post-midnight stops",
    () => {
      // late stop starts 11:30 PM today, ends 12:20 AM tomorrow: its
      // START is today → time-only (straddling midnight doesn't count)
      assert.strictEqual(
        formatStopRange(edt(7, 5, 23, 30), edt(7, 6, 0, 20), REF),
        "11:30 PM – 12:20 AM"
      );
      // the NEXT stop starts 12:40 AM tomorrow → shows "tomorrow"
      assert.strictEqual(
        formatStopRange(edt(7, 6, 0, 40), edt(7, 6, 1, 20), REF),
        "tomorrow, 12:40 AM – 1:20 AM"
      );
    },
  ],
  [
    "formatStopTime for a single labeled time (floor / leave-home)",
    () => {
      assert.strictEqual(formatStopTime(edt(7, 5, 18, 30), REF), "6:30 PM");
      assert.strictEqual(formatStopTime(edt(7, 6, 9, 58), REF), "tomorrow, 9:58 AM");
    },
  ],
  [
    "accepts ISO strings too (round-trips the instant)",
    () => {
      const iso = edt(7, 6, 10, 30).toISOString();
      assert.strictEqual(datePrefix(iso, REF), "tomorrow, ");
    },
  ],
  [
    "a past instant is treated as today (no negative-day prefix)",
    () => {
      assert.strictEqual(datePrefix(edt(7, 4, 10, 0), REF), "");
    },
  ],
  [
    "REGRESSION (midnight-for-lunch): noon EDT renders 12:00 PM for EVERY viewer",
    () => {
      // A lunch resolved to noon Toronto must never display as a viewer's
      // local midnight. Under a UTC/UTC+8 runner the OLD code returned
      // "4:00 PM" / "tomorrow, 12:00 AM" here; pinned strings are
      // Toronto-rendered regardless of runner TZ.
      const ref = edt(7, 11, 11, 20); // mentor's repro: 11:20 AM
      assert.strictEqual(formatStopTime("2026-07-11T12:00:00-04:00", ref), "12:00 PM");
      assert.strictEqual(
        formatStopRange("2026-07-11T12:00:00-04:00", "2026-07-11T13:45:00-04:00", ref),
        "12:00 PM – 1:45 PM"
      );
      // "plan a lunch" at 9 PM → NEXT-day noon, labeled tomorrow — still
      // Toronto's tomorrow, not the viewer's
      assert.strictEqual(
        formatStopTime("2026-07-12T12:00:00-04:00", edt(7, 11, 21, 0)),
        "tomorrow, 12:00 PM"
      );
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
