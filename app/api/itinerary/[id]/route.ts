import { NextRequest } from "next/server";
import {
  clearActiveItineraryForOwner,
  updateItinerary,
  withStatuses,
  type Itinerary,
} from "../store";
import { shouldArchive } from "../ownership";
import { archiveConcludedPlan } from "../history";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  logEvent,
  requestContext,
  validIsoInstant,
} from "../../_shared/http";

/**
 * Archive a plan the moment it is first seen as concluded, and stop pointing
 * the owner at it.
 *
 * Everything here is best-effort and non-fatal: this is a read, and the user
 * is looking at their plan. A Firestore hiccup must not turn that into an
 * error page — it leaves `archivedAt` unset so the next poll simply tries
 * again. Returns whatever itinerary the caller should send back.
 */
async function maybeArchive(itinerary: Itinerary): Promise<Itinerary> {
  // Clearing the pointer is separate from archiving: it applies to EVERY
  // concluded plan, guest included, so a finished outing stops resuming over
  // the landing page whether or not it was ever archived.
  if (itinerary.status === "completed" && itinerary.ownerUid) {
    try {
      await clearActiveItineraryForOwner(itinerary.ownerUid);
    } catch {
      // A stale pointer resolves itself on the next resume attempt, which
      // re-checks `isResumable`. Not worth failing a read over.
    }
  }

  if (!shouldArchive(itinerary)) return itinerary;

  const archivedAt = await archiveConcludedPlan(itinerary);
  if (!archivedAt) return itinerary;

  // Persist the marker through the SAME store seam and CAS path as every
  // other mutation — this is what makes the archive once-only across
  // serverless instances rather than per-process.
  try {
    const committed = await updateItinerary(
      itinerary.id,
      (proposal) => {
        if (proposal.archivedAt) return { value: null, changed: false };
        proposal.archivedAt = archivedAt;
        return { value: null, changed: true };
      },
      { maxAttempts: 3 }
    );
    return committed?.itinerary ?? { ...itinerary, archivedAt };
  } catch (error) {
    // The history document exists but the marker did not commit. The next
    // poll re-archives to the SAME document id, which overwrites rather than
    // duplicating — that is why the doc is keyed by itinerary id.
    logEvent("error", "archive_marker_failed", {
      itineraryId: itinerary.id,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ...itinerary, archivedAt };
  }
}

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

    const updated = await updateItinerary(
      id,
      (proposal) => {
        const touched = { changed: false };
        withStatuses(proposal, t, touched);
        return { value: null, changed: touched.changed };
      },
      { maxAttempts: 3 }
    );
    if (!updated) {
      throw new ApiError(404, "itinerary_not_found", "That itinerary was not found.");
    }
    // ── archive-on-conclude ──
    //
    // This is where conclusion BECOMES OBSERVABLE. There is no "stop
    // itinerary" action in the product and no conclusion event: `withStatuses`
    // DERIVES "completed" from the clock on every read. So the hook attaches
    // to the read that first sees it, and `shouldArchive` carries the
    // once-only guard (`archivedAt`) precisely because this path runs on
    // every poll rather than once.
    //
    // `shouldArchive` also owns the anonymous-vs-real gate: a guest's plan is
    // never written anywhere, so there is no archive to delete later.
    const settled = await maybeArchive(updated.itinerary);
    // No-op polls do not write. A lock/status change commits through CAS and
    // safely retries, so it cannot overwrite a simultaneous swap/reroute.
    return apiJson(ctx, settled, {
      headers: { ETag: `"${settled.version}"` },
    });
  } catch (err) {
    return apiError(ctx, err);
  }
}
