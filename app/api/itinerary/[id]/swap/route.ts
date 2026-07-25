import { NextRequest } from "next/server";
import { loadItinerary, saveItinerary } from "../../store";
import { swapStop } from "../../swap";
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
import { parseOptionalInstant, parseRefinement } from "../../../_shared/schemas";

// POST /api/itinerary/[id]/swap
// body: { stopIndex: number, refinement: string, now?: ISO }
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = requestContext(request, "itinerary_swap");
  const { id } = await params;
  try {
    enforceRateLimit(ctx, 30);
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
      throw new ApiError(400, "invalid_itinerary_id", "Invalid itinerary id.");
    }

    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new ApiError(400, "invalid_request", "Request body must be a JSON object.");
    }
    if (
      !finiteNumber(body.stopIndex) ||
      !Number.isInteger(body.stopIndex) ||
      body.stopIndex < 0 ||
      body.stopIndex > 7
    ) {
      throw new ApiError(
        400,
        "invalid_stop_index",
        "`stopIndex` must be an integer from 0 to 7."
      );
    }
    const stopIndex = body.stopIndex;
    const refinement = parseRefinement(body.refinement);
    const nowISO = parseOptionalInstant(body.now, "now");
    const now = nowISO ? new Date(nowISO) : new Date();

    const itinerary = await loadItinerary(id);
    if (!itinerary) {
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }
    if (stopIndex >= itinerary.stops.length) {
      throw new ApiError(400, "invalid_stop_index", "`stopIndex` is outside this itinerary.");
    }

    const result = await swapStop(itinerary, stopIndex, refinement, now);
    // statuses/lock ratchet mutate even on a refusal — always write back
    await saveItinerary(itinerary);
    return apiJson(ctx, result);
  } catch (err) {
    return apiError(ctx, err);
  }
}
