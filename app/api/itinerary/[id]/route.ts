import { NextRequest } from "next/server";
import { readItineraryWithLifecycle } from "../readLifecycle";
import { loadItinerary } from "../store";
import { isLegacyPlan, ownsItinerary } from "../ownership";
import { verifyCaller } from "../../_shared/caller";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  requestContext,
  validIsoInstant,
} from "../../_shared/http";

// GET /api/itinerary/[id]?now=ISO — itinerary with statuses computed
// against `now`. The ?now param is the dev time control and the
// backbone of reroute testing: any instant can be simulated.
//
// R1 (AUDIT_FINDINGS.md): an OWNED plan is the verified owner's alone. The
// stored itinerary carries `home` (the user's typed starting address and its
// coordinates) and `ownerUid`, so an unauthenticated holder of the link must
// learn NOTHING — not the contents, not that the id exists. UNOWNED / legacy
// plans keep the capability-by-id contract they always had: every plan created
// before ownership shipped, mock e2e (no Admin credentials, so no owner is
// ever stamped), and the gap before a guest's anonymous sign-in resolves.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = requestContext(request, "itinerary_read");
  const { id } = await params;
  try {
    enforceRateLimit(ctx, 180);
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
      throw new ApiError(400, "invalid_itinerary_id", "Invalid itinerary id.");
    }
    const nowParam = request.nextUrl.searchParams.get("now");
    let t = new Date();
    if (nowParam !== null) {
      if (!validIsoInstant(nowParam)) {
        throw new ApiError(400, "invalid_now", "`now` must be a valid ISO timestamp.");
      }
      t = new Date(nowParam);
    }

    // WHO is asking, verified from the token — never from anything the browser
    // asserts. Null (mock e2e, no Admin credentials, guest before anonymous
    // sign-in lands) is guest-level standing. The load runs alongside it: the
    // ownership decision needs the plan, and `ownerUid` is set once at creation
    // and never mutated, so this raw read is authoritative for the gate.
    const [caller, existing] = await Promise.all([
      verifyCaller(request),
      loadItinerary(id),
    ]);
    if (!existing) {
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }
    const legacy = isLegacyPlan(existing);
    if (!legacy && !ownsItinerary(existing, caller)) {
      // Deliberately the SAME 404 a missing plan gets (matching /end): a
      // stranger probing ids learns nothing about which ones exist, and no
      // lifecycle side effect (D3 pointer clear, D5 archive) runs — this
      // throws before `readItineraryWithLifecycle` is ever reached.
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }

    // No-op polls do not write. A lock/status change commits through CAS and
    // safely retries, so it cannot overwrite a simultaneous swap/reroute.
    // An unowned plan passes no caller so the shared read stays permissive for
    // a signed-in caller too; an owned plan passes the verified owner so
    // ownership is re-checked on every CAS retry, exactly as resume does.
    const gateCaller = legacy ? undefined : caller ?? undefined;
    const settled = await readItineraryWithLifecycle(id, t, gateCaller);
    if (!settled) {
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }
    return apiJson(ctx, settled, {
      headers: { ETag: `"${settled.version}"` },
    });
  } catch (err) {
    return apiError(ctx, err);
  }
}
