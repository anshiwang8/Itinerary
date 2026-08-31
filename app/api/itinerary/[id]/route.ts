import { NextRequest } from "next/server";
import { readItineraryWithLifecycle } from "../readLifecycle";
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

    const settled = await readItineraryWithLifecycle(id, t);
    if (!settled) {
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }
    // No-op polls do not write. A lock/status change commits through CAS and
    // safely retries, so it cannot overwrite a simultaneous swap/reroute.
    return apiJson(ctx, settled, {
      headers: { ETag: `"${settled.version}"` },
    });
  } catch (err) {
    return apiError(ctx, err);
  }
}
