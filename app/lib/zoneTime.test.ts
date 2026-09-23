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
  sameLocalDate,
  toZonedISO,
  wallClockParts,
} from "./zoneTime";

const cases: Array<[string, () => void]> = [
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
  [
    "sameLocalDate: compares calendar dates in the zone, not UTC or raw instant proximity",
    () => {
      // same Toronto calendar day, hours apart
      assert.strictEqual(
        sameLocalDate(
          new Date("2026-07-27T15:00:00-04:00"),
          new Date("2026-07-27T20:59:00-04:00"),
          "America/Toronto"
        ),
        true
      );
      // different Toronto calendar day, even though less than 24h apart
      assert.strictEqual(
        sameLocalDate(
          new Date("2026-07-27T00:30:00-04:00"),
          new Date("2026-07-26T23:30:00-04:00"),
          "America/Toronto"
        ),
        false
      );
      // the exact midnight-boundary trap this floor exists to avoid: two
      // instants 40 minutes apart straddling local midnight are NOT the
      // same calendar day, even though they are UTC-adjacent and far closer
      // together than two instants safely inside one day
      assert.strictEqual(
        sameLocalDate(
          new Date("2026-07-26T23:50:00-04:00"),
          new Date("2026-07-27T00:10:00-04:00"),
          "America/Toronto"
        ),
        false
      );
      // a naive UTC-date comparison would get this ONE WRONG: 2026-07-11
      // 02:30 UTC is Toronto's July 10th evening (per the wallClockParts
      // case above), same Toronto calendar day as July 10th 15:00 UTC
      // (Toronto 11:00), even though the raw UTC dates differ
      assert.strictEqual(
        sameLocalDate(
          new Date("2026-07-11T02:30:00Z"),
          new Date("2026-07-10T15:00:00Z"),
          "America/Toronto"
        ),
        true
      );
      // different IANA zone, same instants: Vancouver reads the second pair
      // as its OWN same day too, since both fall on July 10th there also
      assert.strictEqual(
        sameLocalDate(
          new Date("2026-07-11T02:30:00Z"),
          new Date("2026-07-10T15:00:00Z"),
          "America/Vancouver"
        ),
        true
      );
      // an unknown zone falls back to DEFAULT_ZONE rather than throwing
      assert.strictEqual(
        sameLocalDate(
          new Date("2026-07-27T15:00:00-04:00"),
          new Date("2026-07-27T20:00:00-04:00"),
          "Not/AZone"
        ),
        true
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
