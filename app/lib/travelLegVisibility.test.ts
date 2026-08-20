import assert from "node:assert/strict";
import {
  automaticTransitLegId,
  hasLegacyTransitLeg,
  retainManualLegId,
  toggleManualLegId,
  visibleTransitLegIds,
} from "./travelLegVisibility";

const T = (hour: number) => `2026-08-20T${String(hour).padStart(2, "0")}:00:00-04:00`;
const leg = (legId: string, leave: number, arrive: number, mode: "transit" | "walk" = "transit") => ({
  legId,
  mode,
  leaveISO: T(leave),
  arriveISO: T(arrive),
});

{
  const stops = [
    { status: "completed" as const, outbound: leg("current", 18, 19) },
    { status: "upcoming" as const, outbound: leg("later", 21, 22) },
  ];
  assert.equal(automaticTransitLegId({ nowMs: Date.parse(T(18)), stops }), "current");
  assert.equal(automaticTransitLegId({ nowMs: Date.parse(T(19)), stops }), null);
}

{
  const stops = [
    { status: "active" as const, outbound: leg("outbound", 20, 21) },
    { status: "upcoming" as const, outbound: leg("underway", 18, 19) },
  ];
  assert.equal(automaticTransitLegId({ nowMs: Date.parse(T(18)), stops }), "underway");
  assert.equal(automaticTransitLegId({ nowMs: Date.parse(T(17)), stops }), "outbound");
}

{
  const home = leg("home", 17, 18);
  assert.equal(automaticTransitLegId({ nowMs: Date.parse(T(16)), home, stops: [] }), null);
  assert.equal(automaticTransitLegId({ nowMs: Date.parse(T(17)), home, stops: [] }), "home");
  assert.equal(automaticTransitLegId({ nowMs: Date.parse(T(18)), home, stops: [] }), null);
}

{
  const final: Array<{ status: "active" | "completed"; outbound: null }> = [
    { status: "active", outbound: null },
  ];
  assert.equal(automaticTransitLegId({ nowMs: Date.parse(T(20)), stops: final }), null);
  final[0].status = "completed";
  assert.equal(automaticTransitLegId({ nowMs: Date.parse(T(22)), stops: final }), null);
}

assert.deepEqual(visibleTransitLegIds("auto", "manual"), ["auto", "manual"]);
assert.deepEqual(visibleTransitLegIds("same", "same"), ["same"]);
assert.equal(toggleManualLegId(null, "a"), "a");
assert.equal(toggleManualLegId("a", "a"), null);
assert.equal(toggleManualLegId("a", "b"), "b");
assert.equal(retainManualLegId("a", [leg("a", 1, 2)]), "a");
assert.equal(retainManualLegId("a", [leg("b", 1, 2)]), null);
assert.equal(hasLegacyTransitLeg([{ mode: "transit" }]), true);
assert.equal(hasLegacyTransitLeg([leg("a", 1, 2), { mode: "walk" }]), false);

console.log("travelLegVisibility tests passed");
