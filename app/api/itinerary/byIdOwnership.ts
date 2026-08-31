// The by-id OWNERSHIP GATE for the three MUTATION routes: POST /swap,
// POST /remove and POST /mode. AUDIT_FINDINGS.md R1, step 2 — the companion to
// step 1's gate on GET /api/itinerary/[id].
//
// An OWNED plan (`ownerUid` set) may be mutated only by its verified owner.
// The stored itinerary carries `home` — the user's typed starting address and
// its coordinates — and every one of these routes re-prices legs off it, so a
// stranger holding the link must be able to change nothing and learn nothing,
// not even that the id exists. Every other caller (verified as someone else,
// OR unauthenticated) gets the SAME 404 a missing plan returns, matching
// `/end` and the by-id GET; a 401/403 would confirm the id is real.
//
// UNOWNED / legacy plans keep the capability-by-id contract they always had:
// plans created before ownership shipped, mock e2e (no Admin credentials, so
// `stampOwner` never records an owner), and the gap before a guest's anonymous
// sign-in resolves. Forgetting this allowance breaks every mock e2e mutation.
//
// `ownerUid` is written once at creation (`stampOwner`) and never mutated, so
// this raw load is authoritative and the gate runs BEFORE `updateItinerary`
// touches the CAS. The engines (`swapStop`, `removeStop`, `switchTravelMode`)
// are identity-blind and take no caller — the gate is purely a route-boundary
// check, and nothing threads the caller deeper.
//
// The GET route (step 1) keeps its own inline copy of this decision because it
// ALSO passes the verified owner into `readItineraryWithLifecycle` for
// per-CAS-retry re-checks; the mutation routes have no such downstream need, so
// the whole of their gate is this one call. `/reroute` is deliberately still
// ungated — dev-only, behind `SHOW_DEV_CONTROLS`, deferred to a later R1 step.
import type { NextRequest } from "next/server";
import { loadItinerary } from "./store";
import { isLegacyPlan, ownsItinerary } from "./ownership";
import { verifyCaller } from "../_shared/caller";
import { ApiError } from "../_shared/http";

/**
 * Throw an `ApiError(404, "itinerary_not_found", ...)` — indistinguishable from
 * a genuinely missing plan — unless the caller may mutate this plan: an owned
 * plan requires its verified owner, an unowned/legacy plan is open to anyone.
 * Call this after the id regex check and before `updateItinerary`.
 */
export async function enforceItineraryOwnership(
  request: NextRequest,
  id: string
): Promise<void> {
  const [caller, existing] = await Promise.all([
    verifyCaller(request),
    loadItinerary(id),
  ]);
  if (!existing) {
    throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
  }
  if (!isLegacyPlan(existing) && !ownsItinerary(existing, caller)) {
    throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
  }
}
