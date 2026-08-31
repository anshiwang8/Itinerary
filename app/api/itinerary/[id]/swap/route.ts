import { NextRequest } from "next/server";
import { updateItinerary } from "../../store";
import { swapStop } from "../../swap";
import { enforceItineraryOwnership } from "../../byIdOwnership";
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
import {
  parseOptionalInstant,
  parseOptionalVersion,
  parseRefinement,
} from "../../../_shared/schemas";

// POST /api/itinerary/[id]/swap
// body: { stopIndex: number, refinement: string, version?: number, now?: ISO }
//
// AUTH (AUDIT_FINDINGS.md R1, step 2): an owned plan may be swapped only by its
// verified owner — `enforceItineraryOwnership`, the identical gate /remove,
// /mode and the by-id GET run. Unowned/legacy plans stay capability-by-id (mock
// e2e, the guest sign-in race). `/reroute` stays ungated for now (dev-only).
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
    // R1: an owned plan is the verified owner's to mutate; any other caller
    // gets the same 404 a missing plan returns. Runs before the body is read
    // and before any CAS write. Unowned/legacy plans pass through.
    await enforceItineraryOwnership(request, id);

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
    const expectedVersion = parseOptionalVersion(body.version);
    const now = nowISO ? new Date(nowISO) : new Date();
    // The user was shown "this pushes your day to 11:20 PM" and said continue.
    // Strictly boolean-true: anything else (absent, "false", 1, "yes") is NOT
    // consent, because the safe reading of an unclear answer is the one that
    // asks again rather than the one that silently rewrites their evening.
    const endTimeAccepted = body.endTimeAccepted === true;

    const updated = await updateItinerary(
      id,
      async (proposal) => {
        if (stopIndex >= proposal.stops.length) {
          throw new ApiError(
            400,
            "invalid_stop_index",
            "`stopIndex` is outside this itinerary."
          );
        }
        const result = await swapStop(
          proposal,
          stopIndex,
          refinement,
          now,
          {},
          endTimeAccepted
        );
        // A needs-confirmation result is `swapped: false`, so it lands here as
        // `changed: false` — no version bump, no CAS, nothing written. That is
        // the whole mechanism behind "decline costs nothing": the question is
        // asked from a proposal that was never committed in the first place.
        return { value: result, changed: result.swapped };
      },
      { expectedVersion, maxAttempts: 2 }
    );
    if (!updated) {
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }
    // Successful proposals commit as one CAS; refusals do not bump version.
    return apiJson(
      ctx,
      { ...updated.value, version: updated.itinerary.version },
      { headers: { ETag: `"${updated.itinerary.version}"` } }
    );
  } catch (err) {
    return apiError(ctx, err);
  }
}
