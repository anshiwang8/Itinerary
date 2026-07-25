import { NextRequest } from "next/server";
import { loadItinerary, saveItinerary } from "../../store";
import { Disruption, rerouteItinerary } from "../../reroute";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  finiteNumber,
  isRecord,
  readJsonBody,
  requestContext,
} from "../../../_shared/http";
import { parseOptionalInstant } from "../../../_shared/schemas";

// POST /api/itinerary/[id]/reroute
// body: { disruption: { type: "transit_cancelled", legIndex }, now?: ISO }
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = requestContext(request, "itinerary_reroute");
  const { id } = await params;
  try {
    enforceRateLimit(ctx, 30);
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
      throw new ApiError(400, "invalid_itinerary_id", "Invalid itinerary id.");
    }
    const body = await readJsonBody(request);
    if (!isRecord(body) || !isRecord(body.disruption)) {
      throw new ApiError(
        400,
        "invalid_disruption",
        "`disruption` must describe a cancelled transit leg."
      );
    }
    if (
      body.disruption.type !== "transit_cancelled" ||
      !finiteNumber(body.disruption.legIndex) ||
      !Number.isInteger(body.disruption.legIndex) ||
      body.disruption.legIndex < 0 ||
      body.disruption.legIndex > 7
    ) {
      throw new ApiError(
        400,
        "invalid_disruption",
        "`disruption.legIndex` must be an integer from 0 to 7."
      );
    }
    const disruption: Disruption = {
      type: "transit_cancelled",
      legIndex: body.disruption.legIndex,
    };
    const nowISO = parseOptionalInstant(body.now, "now");
    const now = nowISO ? new Date(nowISO) : new Date();

    const itinerary = await loadItinerary(id);
    if (!itinerary) {
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }
    if (disruption.legIndex >= itinerary.stops.length) {
      throw new ApiError(
        400,
        "invalid_disruption",
        "`disruption.legIndex` is outside this itinerary."
      );
    }
    const result = await rerouteItinerary(itinerary, disruption, now);
    // statuses/lock ratchet mutate even when nothing reroutes — write back
    await saveItinerary(itinerary);
    return apiJson(ctx, result);
  } catch (err) {
    return apiError(ctx, err);
  }
}
