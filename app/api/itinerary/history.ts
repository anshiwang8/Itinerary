// A concluded plan's history: the write, and (Stage 2) the read back.
//
// Stage 1B wrote history and nothing read it. Stage 2 adds the READ ONLY —
// `archiveConcludedPlan` and everything it depends on is untouched, so a
// history document written today is identical to one written before this file
// gained a reader.
//
// Both directions live here on purpose: `historyCollection` is the ONE place
// the path `users/<uid>/history` is spelled. A reader that re-derived that
// path elsewhere would be a second copy of the same rule, free to drift.
//
// Firestore holds the ARCHIVE. Redis stays the source of truth for the live
// plan; this is a copy taken at conclusion, not a migration of storage.
import { getAdminFirestore } from "../../lib/firebaseAdmin";
import { logEvent } from "../_shared/http";
import { toArchivedPlan } from "./ownership";
import {
  HISTORY_LIMIT,
  parseHistoryPlan,
  type HistoryPlanPayload,
} from "../../lib/historyView";
import type { Itinerary } from "./store";

/** `users/<uid>/history` — keyed by uid so a read is a single collection
 *  query. Null when Firestore is unavailable; every caller treats that as
 *  "cannot, so don't", never as an error to throw. */
function historyCollection(uid: string) {
  const db = getAdminFirestore();
  return db ? db.collection("users").doc(uid).collection("history") : null;
}

/** One plan's document, keyed by itinerary id so the write is idempotent: the
 *  same plan can only ever occupy its own document. */
function historyDoc(uid: string, itineraryId: string) {
  return historyCollection(uid)?.doc(itineraryId) ?? null;
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

export interface HistoryReadResult {
  plans: HistoryPlanPayload[];
  /** The query itself failed, as opposed to there being nothing to return.
   *  The two look identical on the wire and must not: showing "no saved plans"
   *  to someone who has twenty would read as data loss. */
  readFailed: boolean;
}

/**
 * Every archived plan belonging to ONE uid, newest first.
 *
 * The uid is always the VERIFIED caller's — this function is never handed one
 * from a request. That is the same trust boundary the write side keeps, and
 * the reason the route asks `verifyCaller` before it asks this.
 *
 * NEVER THROWS, mirroring `archiveConcludedPlan`. A history screen that cannot
 * load is a disappointing screen; a history screen that 500s takes the request
 * down with it. The distinction that matters is preserved in `readFailed`
 * rather than in an exception.
 *
 * Documents are normalised through the SAME `parseHistoryPlan` the browser
 * runs over the response, so "what counts as a usable record" is decided once.
 */
export async function readHistoryForOwner(uid: string): Promise<HistoryReadResult> {
  const owner = uid.trim();
  if (owner.length === 0) return { plans: [], readFailed: false };

  const collection = historyCollection(owner);
  if (!collection) {
    // Reaching here means a token verified (so the Admin app initialised) but
    // Firestore did not come back — anomalous, and NOT the same as an empty
    // history, so it is reported as a failed read.
    logEvent("error", "history_read_failed", { reason: "firestore_unavailable" });
    return { plans: [], readFailed: true };
  }

  try {
    // `archivedAt` is set by `toArchivedPlan` on every document this app has
    // ever written, so ordering on it is safe — but note that Firestore OMITS
    // documents missing an ordered field, which is exactly why the client
    // re-sorts what it receives instead of trusting this order.
    const snapshot = await collection
      .orderBy("archivedAt", "desc")
      .limit(HISTORY_LIMIT)
      .get();
    const plans = snapshot.docs
      .map((doc) => parseHistoryPlan(doc.data(), doc.id))
      .filter((plan): plan is HistoryPlanPayload => plan !== null);
    logEvent("info", "history_read", { count: plans.length, returned: snapshot.size });
    return { plans, readFailed: false };
  } catch (error) {
    logEvent("error", "history_read_failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    return { plans: [], readFailed: true };
  }
}
