import assert from "node:assert/strict";
import {
  automaticTravelLegId,
  hasLegacyTransitLeg,
  retainManualLegId,
  toggleManualLegId,
  travelLegVisible,
  visibleTravelLegIds,
} from "./travelLegVisibility";

const T = (hour: number, minute = 0) =>
  `2026-08-20T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-04:00`;
const leg = (legId: string, leave: number, arrive: number, mode: "transit" | "walk" = "transit") => ({
  legId,
  mode,
  leaveISO: T(leave),
  arriveISO: T(arrive),
});

const visible = (
  mode: "transit" | "walk" | "unknown" | undefined,
  legId: string | null | undefined,
  origin: "home" | "interstop" = "interstop",
  visibleLegIds: readonly string[] = [],
  legacyTransitVisibility = false
) =>
  travelLegVisible({
    mode,
    legId,
    origin,
    visibleLegIds,
    legacyTransitVisibility,
  });

const cases: Array<[string, () => void]> = [
  [
    "1. home TRANSIT is automatic before its calculated departure",
    () => {
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(16)),
          home: leg("home", 17, 18),
          stops: [],
        }),
        "home"
      );
    },
  ],
  [
    "2. exact home departure begins the half-open underway interval",
    () => {
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(17)),
          home: leg("home", 17, 18),
          stops: [],
        }),
        "home"
      );
    },
  ],
  [
    "3. home TRANSIT remains automatic while underway",
    () => {
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(17, 30)),
          home: leg("home", 17, 18),
          stops: [],
        }),
        "home"
      );
    },
  ],
  [
    "4. exact first-stop start ends the home exception",
    () => {
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(18)),
          home: leg("home", 17, 18),
          stops: [{ status: "active", outbound: leg("outbound", 19, 20) }],
        }),
        "outbound"
      );
      assert.equal(visible("transit", "home", "home", ["outbound"]), false);
    },
  ],
  [
    "5. loading after first-stop start does not keep home TRANSIT visible",
    () => {
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(18, 1)),
          home: leg("home", 17, 18),
          stops: [{ status: "upcoming", outbound: leg("later", 19, 20) }],
        }),
        null
      );
    },
  ],
  [
    "6. an underway inter-stop leg wins over pre-start home TRANSIT",
    () => {
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(18)),
          home: leg("home", 19, 20),
          stops: [{ status: "upcoming", outbound: leg("underway", 17, 19) }],
        }),
        "underway"
      );
    },
  ],
  [
    "7. an active stop's identified outbound TRANSIT is automatic",
    () => {
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(18)),
          stops: [{ status: "active", outbound: leg("transit-out", 19, 20) }],
        }),
        "transit-out"
      );
    },
  ],
  [
    "8. an active stop's identified outbound WALK is automatic",
    () => {
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(18)),
          stops: [{ status: "active", outbound: leg("walk-out", 19, 20, "walk") }],
        }),
        "walk-out"
      );
      assert.equal(visible("walk", "walk-out", "interstop", ["walk-out"]), true);
    },
  ],
  [
    "9. a future identified WALK is excluded automatically",
    () => {
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(18)),
          stops: [{ status: "upcoming", outbound: leg("future-walk", 20, 21, "walk") }],
        }),
        null
      );
      assert.equal(visible("walk", "future-walk"), false);
    },
  ],
  [
    "10. a completed identified WALK is excluded automatically",
    () => {
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(18)),
          stops: [{ status: "completed", outbound: leg("past-walk", 16, 17, "walk") }],
        }),
        null
      );
      assert.equal(visible("walk", "past-walk"), false);
    },
  ],
  [
    "11. a manually selected identified WALK is added",
    () => {
      assert.deepEqual(visibleTravelLegIds(null, "manual-walk"), ["manual-walk"]);
      assert.equal(visible("walk", "manual-walk", "interstop", ["manual-walk"]), true);
    },
  ],
  [
    "12. automatic and manual selection of the same ID is deduplicated",
    () => {
      assert.deepEqual(visibleTravelLegIds("same", "same"), ["same"]);
    },
  ],
  [
    "13. selecting a second manual leg replaces the first",
    () => {
      assert.equal(toggleManualLegId("first", "second"), "second");
      assert.deepEqual(visibleTravelLegIds("automatic", "second"), ["automatic", "second"]);
    },
  ],
  [
    "14. selecting the current manual leg toggles it off",
    () => {
      assert.equal(toggleManualLegId(null, "walk"), "walk");
      assert.equal(toggleManualLegId("walk", "walk"), null);
    },
  ],
  [
    "15. a stale manual ID is removed",
    () => {
      assert.equal(retainManualLegId("gone", [leg("other", 19, 20, "walk")]), null);
      assert.equal(
        retainManualLegId("gone", [{ ...leg("gone", 19, 20), mode: "unknown" }]),
        null
      );
    },
  ],
  [
    "16. an exact surviving WALK or TRANSIT manual ID is retained",
    () => {
      assert.equal(retainManualLegId("walk", [leg("walk", 19, 20, "walk")]), "walk");
      assert.equal(retainManualLegId("transit", [leg("transit", 19, 20)]), "transit");
    },
  ],
  [
    "17. UNKNOWN is never automatic, retained, or visible",
    () => {
      const unknown = { ...leg("unknown", 17, 19), mode: "unknown" as const };
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(18)),
          stops: [{ status: "active", outbound: unknown }],
        }),
        null
      );
      assert.equal(retainManualLegId("unknown", [unknown]), null);
      assert.equal(visible("unknown", "unknown", "interstop", ["unknown"], true), false);
      assert.equal(visible("unknown", null, "home", [], true), false);
    },
  ],
  [
    "18. identity-absent and legacy transit visibility remain unchanged",
    () => {
      assert.equal(visible("walk", null), true);
      assert.equal(visible("transit", undefined), true);
      assert.equal(hasLegacyTransitLeg([{ mode: "transit" }]), true);
      assert.equal(hasLegacyTransitLeg([leg("modern", 19, 20), { mode: "walk" }]), false);
      assert.equal(visible("transit", "modern", "interstop", [], true), true);
    },
  ],
  [
    "19. identified home WALK retains its always-visible exception",
    () => {
      const homeWalk = leg("home-walk", 17, 18, "walk");
      assert.equal(
        automaticTravelLegId({ nowMs: Date.parse(T(16)), home: homeWalk, stops: [] }),
        null,
        "the transit-only pre-start exception is not broadened"
      );
      assert.equal(visible("walk", "home-walk", "home"), true);
      assert.equal(
        automaticTravelLegId({ nowMs: Date.parse(T(17)), home: homeWalk, stops: [] }),
        "home-walk",
        "an underway home walk is still the current displayable leg"
      );
    },
  ],
  [
    "20. invalid or missing timing does not invent a pre-start boundary",
    () => {
      const home = leg("home", 17, 18);
      assert.equal(
        automaticTravelLegId({ nowMs: Number.NaN, home, stops: [] }),
        null
      );
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(16)),
          home: { ...home, arriveISO: null },
          stops: [],
        }),
        null
      );
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(16)),
          home: { ...home, arriveISO: "not-a-time" },
          stops: [],
        }),
        null
      );
      assert.equal(
        automaticTravelLegId({
          nowMs: Date.parse(T(16)),
          home: { ...home, leaveISO: null },
          stops: [],
        }),
        "home",
        "a valid authoritative first-stop start is sufficient before departure"
      );
    },
  ],
];

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : error}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
