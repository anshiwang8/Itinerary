import { NextRequest } from "next/server";
import { getTravelLegs, LatLng } from "../travel";
import { isMockMode, mockTravelLegs } from "../../_mock/fixtures";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  isRecord,
  readJsonBody,
  requestContext,
  requireServiceKey,
} from "../../_shared/http";
import {
  parseDwellMinutes,
  parseOptionalInstant,
  parsePoints,
} from "../../_shared/schemas";

// POST { points: LatLng[], departureTime?: string, dwellMinutes?: number[] }
//   → { legs: TravelLeg[] }
// dwellMinutes[i] = how long the traveller stays at points[i] (index 0 is
// home, no dwell) so each leg can be routed at its own departure instant.
export async function POST(request: NextRequest) {
  const ctx = requestContext(request, "travel");
  try {
    enforceRateLimit(ctx, 90);
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new ApiError(400, "invalid_request", "Request body must be a JSON object.");
    }
    const points: LatLng[] = parsePoints(body.points);
    const departureTime = parseOptionalInstant(body.departureTime, "departureTime");
    const dwellMinutes = parseDwellMinutes(body.dwellMinutes, points.length);

    // fixture seam: deterministic distance-derived legs, no Routes call.
    // The departure instant and dwells go in for the same reason the live
    // call gets them — each leg is priced (and its board/alight times
    // published) at its OWN departure, not the outing's start.
    if (isMockMode()) {
      return apiJson(ctx, { legs: mockTravelLegs(points, departureTime, dwellMinutes) });
    }
    const apiKey = requireServiceKey(process.env.GOOGLE_ROUTES_API_KEY);
    const legs = await getTravelLegs(apiKey, points, departureTime, dwellMinutes);
    return apiJson(ctx, { legs });
  } catch (err) {
    return apiError(ctx, err);
  }
}
