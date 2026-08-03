import { NextRequest } from "next/server";
import {
  clearActiveItineraryForOwner,
  loadItinerary,
  updateItinerary,
} from "../../store";
import { hasBeenArchived, ownsItinerary } from "../../ownership";
import { archiveConcludedPlan } from "../../history";
import { isStopChoice, resolveStopOutcome } from "../../stopPlan";
import { verifyCaller } from "../../../_shared/caller";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  isRecord,
  logEvent,
  readJsonBody,
  requestContext,
} from "../../../_shared/http";

// POST /api/itinerary/[id]/end — the user pressed "stop itinerary".
//
// The SECOND route to conclusion. The end-time one still lives on the by-id
// GET and is untouched; this is the one a person triggers, and it can happen
// while every stop is still in the future.
//
// It does not fork any of the machinery it needs: the Firestore write is the
// same `archiveConcludedPlan` the end-time path calls, so a history document
// written here is byte-identical in shape to one written by the clock; and the
// plan is mutated through `updateItinerary`, so CAS versioning applies exactly
// as it does to a swap or a reroute.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = requestContext(request, "itinerary_end");
  const { id } = await params;
  try {
    enforceRateLimit(ctx, 60);
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
      throw new ApiError(400, "invalid_itinerary_id", "Invalid itinerary id.");
    }
    const body = await readJsonBody(request);
    if (!isRecord(body) || !isStopChoice(body.choice)) {
      throw new ApiError(
        400,
        "invalid_stop_choice",
        "`choice` must be one of save-end, discard-end, cancel."
      );
    }

    // WHO is ending this. Only the owner may end their own plan, and only the
    // VERIFIED identity decides whether saving is even allowed.
    const caller = await verifyCaller(request);
    if (!caller) {
      throw new ApiError(401, "unauthenticated", "Sign-in is required to end a plan.");
    }
    const existing = await loadItinerary(id);
    if (!existing) {
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }
    if (!ownsItinerary(existing, caller)) {
      // Deliberately the same 404 a missing plan gets: someone probing ids
      // learns nothing about which ones exist.
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }

    // The browser says which button was pressed; the server decides what that
    // MEANS, from the verified caller's anonymity. A guest asking to save
    // still does not archive.
    const outcome = resolveStopOutcome(caller.isAnonymous, body.choice);
    if (!outcome.shouldEnd) {
      // Cancel. Nothing is written, nothing is concluded.
      return apiJson(ctx, { ended: false, archived: false });
    }

    // Archive BEFORE ending, and only if the plan is not already in history
    // (the clock may have archived it moments earlier). Non-fatal by the same
    // reasoning as the end-time path: failing to keep a copy must not prevent
    // the user from ending the plan they asked to end.
    let archivedAt: string | null = null;
    if (outcome.shouldArchive && !hasBeenArchived(existing)) {
      archivedAt = await archiveConcludedPlan(existing);
      if (!archivedAt) {
        logEvent("error", "stop_archive_failed", { itineraryId: id });
      }
    }

    const endedAt = new Date().toISOString();
    const committed = await updateItinerary(
      id,
      (proposal) => {
        // Idempotent: ending an already-ended plan changes nothing.
        if (proposal.endedAt) return { value: null, changed: false };
        proposal.endedAt = endedAt;
        if (archivedAt && !proposal.archivedAt) proposal.archivedAt = archivedAt;
        return { value: null, changed: true };
      },
      { maxAttempts: 3 }
    );

    // Stop pointing the owner at it, so a refresh finds nothing to resume.
    // `endedAt` already makes the plan itself unresumable, so this is the
    // second of two independent guards rather than the only one — which is
    // why a failure here is logged and swallowed instead of failing the call.
    try {
      await clearActiveItineraryForOwner(caller.uid);
    } catch (error) {
      logEvent("error", "stop_index_clear_failed", {
        itineraryId: id,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    logEvent("info", "itinerary_ended", {
      itineraryId: id,
      choice: body.choice,
      archived: archivedAt !== null,
      wasAlreadyArchived: hasBeenArchived(existing),
    });

    return apiJson(ctx, {
      ended: true,
      archived: archivedAt !== null || (outcome.shouldArchive && hasBeenArchived(existing)),
      version: committed?.itinerary.version ?? existing.version,
    });
  } catch (err) {
    return apiError(ctx, err);
  }
}
