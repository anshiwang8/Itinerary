// Writing a concluded plan into its owner's history.
//
// Stage 1B WRITES history and nothing reads it yet — the viewing screen is
// Stage 2. That is deliberate: the archive has to start accumulating before
// there is anything to show, and a write-only slice is far easier to verify.
//
// Firestore holds the ARCHIVE. Redis stays the source of truth for the live
// plan; this is a copy taken at conclusion, not a migration of storage.
import { getAdminFirestore } from "../../lib/firebaseAdmin";
import { logEvent } from "../_shared/http";
import { toArchivedPlan } from "./ownership";
import type { Itinerary } from "./store";

/** `users/<uid>/history/<itineraryId>` — keyed by uid so a future read is a
 *  single collection query, and by itinerary id so the write is idempotent:
 *  the same plan can only ever occupy its own document. */
function historyDoc(uid: string, itineraryId: string) {
  const db = getAdminFirestore();
  return db ? db.collection("users").doc(uid).collection("history").doc(itineraryId) : null;
}

/**
 * Archive a concluded plan. Returns the archive timestamp on success, or null
 * when nothing was written.
 *
 * NEVER THROWS. The caller is a GET that happened to notice the plan had
 * finished; failing that read because a secondary write failed would break
 * the actual product to protect a feature nobody is looking at yet. A failure
 * is logged and leaves `archivedAt` unset, so the next poll retries naturally.
 *
 * The anonymous-vs-real decision is NOT made here — `shouldArchive` owns it,
 * so it can be unit-tested without Firestore. This function assumes it has
 * already been asked.
 */
export async function archiveConcludedPlan(itinerary: Itinerary): Promise<string | null> {
  const uid = itinerary.ownerUid?.trim();
  if (!uid) return null;

  const doc = historyDoc(uid, itinerary.id);
  if (!doc) {
    logEvent("error", "history_archive_skipped", {
      itineraryId: itinerary.id,
      reason: "firestore_unavailable",
    });
    return null;
  }

  const archivedAt = new Date().toISOString();
  try {
    await doc.set(toArchivedPlan(itinerary, archivedAt));
    logEvent("info", "history_archived", {
      itineraryId: itinerary.id,
      stops: itinerary.stops.length,
    });
    return archivedAt;
  } catch (error) {
    logEvent("error", "history_archive_failed", {
      itineraryId: itinerary.id,
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
