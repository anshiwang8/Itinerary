import { NextRequest } from "next/server";
import { createItinerary, saveItinerary } from "./store";
import { ScheduledStop } from "../schedule/schedule";
import { TravelLeg } from "../schedule/travel";
import { HomePoint } from "../schedule/home";
import { ParsedPrompt } from "../places/search/filter";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  isRecord,
  readJsonBody,
  requestContext,
} from "../_shared/http";
import {
  parseHomePoint,
  parseOptionalTimeZone,
  parseParsedPrompt,
  parseScheduledStops,
  parseTravelLegs,
} from "../_shared/schemas";

// POST /api/itinerary — store the full pipeline output, return { id }.
export async function POST(request: NextRequest) {
  const ctx = requestContext(request, "itinerary_create");
  try {
    enforceRateLimit(ctx, 60);
    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      throw new ApiError(400, "invalid_request", "Request body must be a JSON object.");
    }
    const stops: ScheduledStop[] = parseScheduledStops(body.stops);
    const legs: TravelLeg[] = parseTravelLegs(body.legs);
    const parsed: ParsedPrompt | undefined =
      body.parsed === undefined ? undefined : parseParsedPrompt(body.parsed);
    const homeLeg: TravelLeg | undefined =
      body.homeLeg === undefined
        ? undefined
        : parseTravelLegs([body.homeLeg], "homeLeg")[0];
    const home: HomePoint | undefined = parseHomePoint(body.home);
    const timeZone = parseOptionalTimeZone(body.timeZone);

    const itinerary = createItinerary(stops, legs, parsed, homeLeg, home, timeZone);
    await saveItinerary(itinerary);
    return apiJson(ctx, { id: itinerary.id });
  } catch (err) {
    return apiError(ctx, err);
  }
}
