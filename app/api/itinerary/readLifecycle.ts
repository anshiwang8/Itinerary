import {
  clearActiveItineraryForOwner,
  updateItinerary,
  withStatuses,
  type Itinerary,
} from "./store";
import { ownsItinerary, shouldArchive, type CallerIdentity } from "./ownership";
import { archiveConcludedPlan } from "./history";
import { logEvent } from "../_shared/http";

/**
 * Archive a plan the moment it is first seen as concluded, and stop pointing
 * the owner at it.
 *
 * Everything here is best-effort and non-fatal: this is a read, and the user
 * is looking at their plan. A Firestore hiccup must not turn that into an
 * error response — it leaves `archivedAt` unset so the next read simply tries
 * again. Returns whatever itinerary the caller should send back.
 */
async function maybeArchive(itinerary: Itinerary): Promise<Itinerary> {
  // Clearing the pointer is separate from archiving: it applies to EVERY
  // concluded plan, guest included, so a finished outing stops resuming over
  // the landing page whether or not it was ever archived.
  if (itinerary.status === "completed" && itinerary.ownerUid) {
    try {
      await clearActiveItineraryForOwner(itinerary.ownerUid, itinerary.id);
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
    // read re-archives to the SAME document id, which overwrites rather than
    // duplicating — that is why the doc is keyed by itinerary id.
    logEvent("error", "archive_marker_failed", {
      itineraryId: itinerary.id,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ...itinerary, archivedAt };
  }
}

/**
 * One lifecycle for by-id and active-plan reads: persist status/lock changes
 * through CAS, then perform best-effort conclusion work. Resume supplies its
 * verified caller; check ownership on EVERY proposal/retry before any write
 * or owner-scoped side effect. The by-id GET route now gates ownership at its
 * own boundary before calling this (audit R1 step 1); the three by-id MUTATION
 * routes gate there too (R1 step 2). This function's own caller check remains
 * for resume, where the caller is threaded in rather than checked upstream.
 */
export async function readItineraryWithLifecycle(
  id: string,
  t: Date,
  caller?: CallerIdentity
): Promise<Itinerary | undefined> {
  const updated = await updateItinerary(
    id,
    (proposal) => {
      if (caller && !ownsItinerary(proposal, caller)) {
        return { value: false, changed: false };
      }
      const touched = { changed: false };
      withStatuses(proposal, t, touched);
      return { value: true, changed: touched.changed };
    },
    { maxAttempts: 3 }
  );
  if (!updated || !updated.value) return undefined;
  return maybeArchive(updated.itinerary);
}
