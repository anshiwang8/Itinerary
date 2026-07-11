// Tests for the zone-aware primitives. Fixtures are EXPLICIT absolute
// instants (ISO with offset), so every assertion holds under ANY runner
// TZ — run both ways to prove it:
//   npx tsx app/lib/zoneTime.test.ts
//   TZ=UTC npx tsx app/lib/zoneTime.test.ts
import assert from "node:assert";
import {
  DEFAULT_ZONE,
  instantAtWallClock,
  nextFullHourInZone,
  normalizeZone,
  toZonedISO,
  wallClockParts,
  zoneFromLatLng,
} from "./zoneTime";

const cases: Array<[string, () => void]> = [
  [
    "zoneFromLatLng: real cities, bad coords fall back to default",
    () => {
      assert.strictEqual(zoneFromLatLng(43.6547, -79.3862), "America/Toronto");
      assert.strictEqual(zoneFromLatLng(49.2827, -123.1207), "America/Vancouver");
      assert.strictEqual(zoneFromLatLng(51.5074, -0.1278), "Europe/London");
      assert.strictEqual(zoneFromLatLng(NaN, NaN), DEFAULT_ZONE);
    },
  ],
  [
    "normalizeZone: junk → default, valid → itself",
    () => {
      assert.strictEqual(normalizeZone("America/Vancouver"), "America/Vancouver");
      assert.strictEqual(normalizeZone("Not/AZone"), DEFAULT_ZONE);
      assert.strictEqual(normalizeZone(undefined), DEFAULT_ZONE);
      assert.strictEqual(normalizeZone(""), DEFAULT_ZONE);
    },
  ],
  [
    "toZonedISO: byte-compat Toronto across DST; other zones render their own offset",
    () => {
      // summer EDT -04:00, winter EST -05:00 — the exact old toTorontoISO shape
      assert.strictEqual(toZonedISO(new Date("2026-07-03T23:00:00Z")), "2026-07-03T19:00:00-04:00");
      assert.strictEqual(toZonedISO(new Date("2026-01-15T17:30:00Z")), "2026-01-15T12:30:00-05:00");
      // same instant, Vancouver
      assert.strictEqual(
        toZonedISO(new Date("2026-07-03T23:00:00Z"), "America/Vancouver"),
        "2026-07-03T16:00:00-07:00"
      );
    },
  ],
  [
    "wallClockParts: same instant is a different day/hour/weekday per zone",
    () => {
      // 2026-07-11 02:30 UTC → Fri 22:30 in Toronto, Fri 19:30 in Vancouver,
      // and both are the PREVIOUS calendar day vs UTC's Saturday
      const inst = new Date("2026-07-11T02:30:00Z");
      const tor = wallClockParts(inst, "America/Toronto");
      assert.deepStrictEqual(
        [tor.year, tor.month, tor.day, tor.hour, tor.minute, tor.weekday],
        [2026, 7, 10, 22, 30, 5] // Fri = 5
      );
      const van = wallClockParts(inst, "America/Vancouver");
      assert.deepStrictEqual([van.day, van.hour, van.weekday], [10, 19, 5]);
      // weekday convention: Sunday is 0
      const sun = wallClockParts(new Date("2026-07-12T16:00:00Z"), "America/Toronto");
      assert.strictEqual(sun.weekday, 0);
    },
  ],
  [
    "nextFullHourInZone: floors to the hour in the plan zone, +1h",
    () => {
      // 20:20 UTC = 16:20 EDT → next Toronto hour 17:00 EDT = 21:00 UTC
      const now = new Date("2026-07-11T20:20:00Z");
      assert.strictEqual(nextFullHourInZone(now, "America/Toronto").toISOString(), "2026-07-11T21:00:00.000Z");
      // same instant in Vancouver = 13:20 PDT → 14:00 PDT = 21:00 UTC (same
      // absolute hour boundary here, but computed against Vancouver's clock)
      assert.strictEqual(nextFullHourInZone(now, "America/Vancouver").toISOString(), "2026-07-11T21:00:00.000Z");
    },
  ],
  [
    "instantAtWallClock: sets the wall hour in the zone; rollForward bumps a local day",
    () => {
      const now = new Date("2026-07-11T16:00:00Z"); // 12:00 EDT / 09:00 PDT
      // 19:00 in Toronto today = 23:00 UTC
      assert.strictEqual(
        instantAtWallClock(now, "America/Toronto", 19, 0).toISOString(),
        "2026-07-11T23:00:00.000Z"
      );
      // 19:00 in Vancouver today = 02:00 UTC next day
      assert.strictEqual(
        instantAtWallClock(now, "America/Vancouver", 19, 0).toISOString(),
        "2026-07-12T02:00:00.000Z"
      );
      // rollForward: 08:00 Toronto already passed at 12:00 → tomorrow 08:00
      assert.strictEqual(
        instantAtWallClock(now, "America/Toronto", 8, 0, 0, true).toISOString(),
        "2026-07-12T12:00:00.000Z"
      );
      // no rollForward → today's (past) 08:00 stays
      assert.strictEqual(
        instantAtWallClock(now, "America/Toronto", 8, 0, 0, false).toISOString(),
        "2026-07-11T12:00:00.000Z"
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
