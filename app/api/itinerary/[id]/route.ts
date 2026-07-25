import { NextRequest } from "next/server";
import { loadItinerary, saveItinerary, withStatuses } from "../store";
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

    const itinerary = await loadItinerary(id);
    if (!itinerary) {
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }
    // the locked ratchet mutates — persist it, or backwards time travel on
    // another instance could unlock a stop. But ONLY when something
    // actually moved: this route is polled (the dev time picker fires a GET
    // per change), and an unconditional write was a Redis round trip per
    // read that also refreshed the TTL, so an actively-viewed plan never
    // expired (code-audit 2026-07-18 §2.4).
    const touched = { changed: false };
    const result = withStatuses(itinerary, t, touched);
    if (touched.changed) await saveItinerary(result);
    return apiJson(ctx, result);
  } catch (err) {
    return apiError(ctx, err);
  }
}
