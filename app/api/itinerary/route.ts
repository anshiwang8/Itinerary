import { NextRequest } from "next/server";
import {
  activeItineraryIdForOwner,
  createItinerary,
  saveItinerary,
  setActiveItineraryForOwner,
} from "./store";
import { isResumable, stampOwner } from "./ownership";
import { readItineraryWithLifecycle } from "./readLifecycle";
import { verifyCaller } from "../_shared/caller";
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
  logEvent,
  readJsonBody,
  requestContext,
} from "../_shared/http";
import {
  parseHomePoint,
  parseOptionalInstant,
  parseOptionalTimeZone,
  parseOptionalTravelMode,
  parseParsedPrompt,
  parseScheduledStops,
  parseTravelLegs,
  validateTravelIdentityTopology,
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
    validateTravelIdentityTopology(
      [...(homeLeg ? [homeLeg] : []), ...legs],
      "homeLeg/legs"
    );
    const home: HomePoint | undefined = parseHomePoint(body.home);
    const timeZone = parseOptionalTimeZone(body.timeZone);
    // The end the user STATED, if they stated one. Optional on purpose: most
    // prompts name no finish, and absent means "no ceiling" downstream rather
    // than a default anyone invented.
    const plannedEndISO = parseOptionalInstant(body.plannedEndISO, "plannedEndISO");
    // How the plan travels, chosen at the landing toggle. Absent = transit,
    // which is what every plan created before drive mode sends.
    const travelMode = parseOptionalTravelMode(body.travelMode);

    // WHO is creating this, verified from the token — never from the body.
    // Null (mock e2e, no Admin credentials, guest before anonymous sign-in
    // lands) simply produces an unowned plan, which behaves exactly as plans
    // did before this slice.
    const caller = await verifyCaller(request);
    const itinerary = stampOwner(
      createItinerary(
        stops,
        legs,
        parsed,
        homeLeg,
        home,
        timeZone,
        plannedEndISO,
        travelMode
      ),
      caller
    );
    const stored = await saveItinerary(itinerary);
    // Point the owner at their new plan so a refresh can find it again. AFTER
    // the save, and deliberately non-fatal: the plan exists and is usable
    // whether or not the pointer lands, so a failed index write must not fail
    // a successful creation.
    if (caller) {
      try {
        await setActiveItineraryForOwner(caller.uid, stored.id);
      } catch (indexError) {
        logEvent("error", "owner_index_write_failed", {
          itineraryId: stored.id,
          detail: indexError instanceof Error ? indexError.message : String(indexError),
        });
      }
    }
    return apiJson(
      ctx,
      { id: stored.id, version: stored.version },
      { headers: { ETag: `"${stored.version}"` } }
    );
  } catch (err) {
    return apiError(ctx, err);
  }
}

// GET /api/itinerary — the caller's ACTIVE plan, or null.
//
// This is the fix for "refresh loses my plan". The plan was never lost: it
// sits in Redis for seven days. The PAGE forgot which id it was showing,
// because the itinerary lived in React state and nothing else. So the answer
// is a lookup, not more persistence.
export async function GET(request: NextRequest) {
  const ctx = requestContext(request, "itinerary_active");
  try {
    enforceRateLimit(ctx, 120);
    const caller = await verifyCaller(request);
    // No verified caller = nothing to resume. Not an error: this is every
    // mock-e2e request and every visit before anonymous sign-in resolves.
    if (!caller) return apiJson(ctx, { itinerary: null });

    const activeId = await activeItineraryIdForOwner(caller.uid);
    if (!activeId) return apiJson(ctx, { itinerary: null });

    const settled = await readItineraryWithLifecycle(activeId, new Date(), caller);
    // A pointer can outlive its plan (TTL, manual deletion). Degrade to "no
    // active plan" rather than 404-ing a page load.
    // The shared read has already checked ownership, persisted statuses and
    // handled conclusion. A concluded/ended plan still must not resume.
    if (!settled || !isResumable(settled)) return apiJson(ctx, { itinerary: null });

    return apiJson(ctx, { itinerary: settled });
  } catch (err) {
    return apiError(ctx, err);
  }
}
