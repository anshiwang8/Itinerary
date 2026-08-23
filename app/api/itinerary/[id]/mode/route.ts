import { NextRequest } from "next/server";
import { updateItinerary } from "../../store";
import { switchTravelMode } from "../../modeSwitch";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  isRecord,
  readJsonBody,
  requestContext,
} from "../../../_shared/http";
import {
  parseOptionalInstant,
  parseOptionalTravelMode,
  parseOptionalVersion,
} from "../../../_shared/schemas";

// POST /api/itinerary/[id]/mode
// body: { travelMode: "transit" | "driving", version?: number, now?: ISO }
//
// A SIBLING OF THE REMOVE ROUTE, which is itself a sibling of swap. Everything
// structural is deliberately identical — the id shape, the rate limit, the CAS
// through `updateItinerary` with `expectedVersion`, the version echo and the
// ETag — because this is the same kind of mutation on the same object.
//
// WHERE IT DIFFERS IS THE BODY, which is why it is its own file rather than a
// mode of /swap or /remove. A swap requires a non-empty `refinement` that the
// engine hands to a model; a removal points at a stop index. This names a
// TRAVEL MODE and no stop at all — the whole plan is the subject. Folding it
// into either would mean branching that route on an absent field, which is the
// same fork one level up.
//
// `travelMode` is REQUIRED here, and that is the one place this departs from
// the shared validator's meaning: `parseOptionalTravelMode` treats undefined
// as "unstated, meaning transit", which is right for a plan being CREATED and
// wrong for a request whose entire content is which mode to move to. The
// allowlist is still that function's — an unknown string is rejected rather
// than coerced — and the required-ness is checked on top of it.
//
// AUTH follows the swap and remove precedent exactly: none beyond the plan id.
// Only `/end` verifies a caller, because ending a plan writes to a person's
// history. This writes only to the plan itself.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = requestContext(request, "itinerary_mode");
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
    const travelMode = parseOptionalTravelMode(body.travelMode);
    if (!travelMode) {
      throw new ApiError(
        400,
        "invalid_travel_mode",
        '`travelMode` is required and must be "transit" or "driving".'
      );
    }
    const nowISO = parseOptionalInstant(body.now, "now");
    const expectedVersion = parseOptionalVersion(body.version);
    const now = nowISO ? new Date(nowISO) : new Date();

    const updated = await updateItinerary(
      id,
      async (proposal) => {
        const result = await switchTravelMode(proposal, travelMode, now);
        // A refusal — including the no-op of switching to the mode the plan
        // is already in — is `switched: false`, which lands here as
        // `changed: false`: no version bump, no CAS, nothing written. The
        // engine already left the proposal untouched, so this is the second
        // half of the same guarantee rather than a cleanup.
        return { value: result, changed: result.switched };
      },
      { expectedVersion, maxAttempts: 2 }
    );
    if (!updated) {
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }
    return apiJson(
      ctx,
      { ...updated.value, version: updated.itinerary.version },
      { headers: { ETag: `"${updated.itinerary.version}"` } }
    );
  } catch (err) {
    return apiError(ctx, err);
  }
}
