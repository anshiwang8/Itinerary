// Pure content-sequencing for the mobile sheet, proven without React or a
// DOM. Same StripHome/StripStop shapes ItineraryStrip itself renders.
import assert from "node:assert";
import { buildSheetEntries, pickPeekStop } from "./mobileSheetLayout";
import type { StripHome, StripLeg, StripStop } from "../ItineraryStrip";

type Case = [string, () => void];

function leg(overrides: Partial<StripLeg> = {}): StripLeg {
  return {
    mode: "walk",
    totalMinutes: 10,
    marginMinutes: 0,
    ...overrides,
  };
}

function stop(overrides: Partial<StripStop> = {}): StripStop {
  return {
    id: "s1",
    category: "food",
    name: "Test Venue",
    start: "2026-09-03T19:00:00-04:00",
    end: "2026-09-03T20:00:00-04:00",
    status: "upcoming",
    ...overrides,
  };
}

const HOME: StripHome = { label: "89 Chestnut Street", leaveBy: "6:45 PM" };

const cases: Case[] = [
  [
    "buildSheetEntries: no home, no stops -> empty",
    () => {
      assert.deepStrictEqual(buildSheetEntries(null, []), []);
    },
  ],
  [
    "buildSheetEntries: home with no leg and one stop with no outbound leg",
    () => {
      const s1 = stop({ id: "s1" });
      const entries = buildSheetEntries(HOME, [s1]);
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].kind, "home");
      assert.strictEqual(entries[1].kind, "stop");
    },
  ],
  [
    "buildSheetEntries: home's own leg is inserted right after home, before the first stop",
    () => {
      const homeWithLeg: StripHome = { ...HOME, leg: leg({ mode: "transit" }) };
      const s1 = stop({ id: "s1" });
      const entries = buildSheetEntries(homeWithLeg, [s1]);
      assert.deepStrictEqual(
        entries.map((e) => e.kind),
        ["home", "leg", "stop"]
      );
      assert.strictEqual((entries[1] as { id: string }).id, "home-leg");
    },
  ],
  [
    "buildSheetEntries: alternates stop/leg/stop/leg for a multi-stop plan, matching ItineraryStrip's own order",
    () => {
      const s1 = stop({ id: "s1", legToNext: leg({ mode: "walk" }) });
      const s2 = stop({ id: "s2", legToNext: leg({ mode: "transit" }) });
      const s3 = stop({ id: "s3" }); // last stop: no outbound leg
      const entries = buildSheetEntries(null, [s1, s2, s3]);
      assert.deepStrictEqual(
        entries.map((e) => e.kind),
        ["stop", "leg", "stop", "leg", "stop"]
      );
    },
  ],
  [
    "buildSheetEntries: leg entry ids are stable and keyed off the stop they leave, never off legId",
    () => {
      const s1 = stop({ id: "venue-a", legToNext: leg({ legId: null }) });
      const entries = buildSheetEntries(null, [s1]);
      const legEntry = entries[1];
      assert.strictEqual(legEntry.kind, "leg");
      assert.strictEqual((legEntry as { id: string }).id, "leg-venue-a");
    },
  ],
  [
    "buildSheetEntries: a stop with legToNext=null contributes no leg entry",
    () => {
      const s1 = stop({ id: "s1", legToNext: null });
      const entries = buildSheetEntries(null, [s1]);
      assert.strictEqual(entries.length, 1);
    },
  ],
  [
    "pickPeekStop: no stops -> null",
    () => {
      assert.strictEqual(pickPeekStop([]), null);
    },
  ],
  [
    "pickPeekStop: an active stop wins over any upcoming ones",
    () => {
      const s1 = stop({ id: "s1", status: "completed" });
      const s2 = stop({ id: "s2", status: "active" });
      const s3 = stop({ id: "s3", status: "upcoming" });
      assert.strictEqual(pickPeekStop([s1, s2, s3])?.id, "s2");
    },
  ],
  [
    "pickPeekStop: with no active stop, the FIRST upcoming stop wins",
    () => {
      const s1 = stop({ id: "s1", status: "completed" });
      const s2 = stop({ id: "s2", status: "upcoming" });
      const s3 = stop({ id: "s3", status: "upcoming" });
      assert.strictEqual(pickPeekStop([s1, s2, s3])?.id, "s2");
    },
  ],
  [
    "pickPeekStop: every stop completed/skipped -> falls back to the LAST stop",
    () => {
      const s1 = stop({ id: "s1", status: "completed" });
      const s2 = stop({ id: "s2", status: "skipped" });
      const s3 = stop({ id: "s3", status: "completed" });
      assert.strictEqual(pickPeekStop([s1, s2, s3])?.id, "s3");
    },
  ],
  [
    "pickPeekStop: a single active stop is returned even as the only stop",
    () => {
      const s1 = stop({ id: "only", status: "active" });
      assert.strictEqual(pickPeekStop([s1])?.id, "only");
    },
  ],
];

function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
