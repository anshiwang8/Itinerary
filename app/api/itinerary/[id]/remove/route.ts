import { NextRequest } from "next/server";
import { updateItinerary } from "../../store";
import { removeStop } from "../../removeStop";
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
import { parseOptionalInstant, parseOptionalVersion } from "../../../_shared/schemas";

// POST /api/itinerary/[id]/remove
// body: { stopIndex: number, version?: number, now?: ISO }
//
// A SIBLING OF THE SWAP ROUTE, not a mode of it. Everything structural is
// deliberately identical — the id shape, the CAS through `updateItinerary`, the
// version echo and the ETag — because this is the same kind of mutation on the
// same object, and the two should differ only where they genuinely differ.
//
// WHERE THEY GENUINELY DIFFER IS THE BODY, and it is why this is its own file.
// A swap is driven by a `refinement`: a required, non-empty sentence that the
// engine hands to a model to classify. A removal has nothing to say — the
// user pointed at a stop and asked for it to be gone. Folding it into
// /swap would mean either inventing a sentinel refinement, which puts a made-up
// phrase in front of the LLM for an operation that must never consult one, or
// branching the route on an absent field, which is the same fork one level up.
//
// AUTH follows the swap precedent exactly: none beyond the plan id. Verified
// against current code — `/swap` and `/reroute` do no caller verification, and
// only `/end` calls `verifyCaller`, because ending a plan writes to a person's
// history. A removal writes only to the plan itself, like a swap.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = requestContext(request, "itinerary_remove");
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
    const nowISO = parseOptionalInstant(body.now, "now");
    const expectedVersion = parseOptionalVersion(body.version);
    const now = nowISO ? new Date(nowISO) : new Date();

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
        const result = await removeStop(proposal, stopIndex, now);
        // A refusal is `removed: false`, which lands here as `changed: false`:
        // no version bump, no CAS, nothing written. The engine already left the
        // proposal untouched, so this is the second half of the same guarantee
        // rather than a cleanup.
        return { value: result, changed: result.removed };
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
