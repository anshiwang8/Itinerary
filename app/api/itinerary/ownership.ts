// Who a plan belongs to, and whether it earns a place in someone's history.
//
// PURE — no Firebase, no Firestore, no network, no store. That is deliberate:
// token verification and the Firestore write are live-only and can't be
// meaningfully mock-tested, but the DECISIONS around them are ordinary
// branching, so they live here where `ownership.test.ts` can pin them.
//
// The invariant that shapes every function: an absent owner is not an error.
// Plans created before this slice have no owner, mock e2e runs with no
// Firebase at all, and both must keep working — same keep-on-missing-data
// bargain the filters make.
import type { Itinerary } from "./store";

/** A caller the SERVER verified. Never built from a browser-supplied uid —
 *  see `app/api/_shared/caller.ts`; an unverified request has no identity. */
export interface CallerIdentity {
  uid: string;
  /** true for Firebase anonymous sign-in (a guest). Guests get the full app
   *  and a persistent plan; they just never get history. */
  isAnonymous: boolean;
}

/** Blank/whitespace uids are absent, not owners — same rule authUser applies
 *  to a provider payload. */
function ownerUidOf(itinerary: Itinerary): string | null {
  const raw = itinerary.ownerUid;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A plan created before this slice, or by an unauthenticated caller (mock
 *  e2e, missing Admin credentials). Readable and mutable as always — it
 *  simply has nobody to resume for and nobody to archive to. */
export function isLegacyPlan(itinerary: Itinerary): boolean {
  return ownerUidOf(itinerary) === null;
}

/**
 * Attach the verified caller to a new plan. A null caller stamps NOTHING
 * rather than a placeholder: "unknown owner" and "owned by the string
 * 'unknown'" behave differently everywhere downstream, and only one of them
 * is true.
 */
export function stampOwner(itinerary: Itinerary, caller: CallerIdentity | null): Itinerary {
  if (!caller) return itinerary;
  const uid = caller.uid.trim();
  if (uid.length === 0) return itinerary;
  return { ...itinerary, ownerUid: uid, ownerIsAnonymous: caller.isAnonymous };
}

/** Whether this caller owns this plan. An unowned (legacy) plan is nobody's,
 *  so it is never claimed by whoever happens to load it. */
export function ownsItinerary(itinerary: Itinerary, caller: CallerIdentity | null): boolean {
  if (!caller) return false;
  const owner = ownerUidOf(itinerary);
  return owner !== null && owner === caller.uid.trim();
}

/**
 * A plan is resumable until it has concluded — by the clock OR by choice.
 *
 * `withStatuses` derives "completed" from the clock, so this reads the derived
 * status rather than re-deciding it; code owns that arithmetic in one place.
 * `endedAt` is the second route: a plan someone stopped on purpose is over
 * even though its stops may still be in the future, and it must not reappear
 * on the next refresh. Clearing the owner pointer is what normally prevents
 * that, but this makes it true of the plan ITSELF, so a stale pointer cannot
 * resurrect something the user deliberately finished.
 */
export function isResumable(itinerary: Itinerary): boolean {
  if (hasBeenEnded(itinerary)) return false;
  return itinerary.status !== "completed";
}

/** Whether a person explicitly ended this plan. */
export function hasBeenEnded(itinerary: Itinerary): boolean {
  return typeof itinerary.endedAt === "string" && itinerary.endedAt.trim().length > 0;
}

/** A deliberate discard stays discarded even after its stop times elapse. */
export function hasBeenDiscarded(itinerary: Itinerary): boolean {
  return typeof itinerary.discardedAt === "string" && itinerary.discardedAt.trim().length > 0;
}

/**
 * Does this concluded plan get written to history?
 *
 * Five conditions, and every one of them has a reason:
 *  - NOT DISCARDED. Ending without saving is a durable user decision, not
 *    an archive failure. Legacy plans without a disposition keep working.
 *  - CONCLUDED. History is for finished outings; an active plan lives in
 *    Redis and is still changing.
 *  - HAS AN OWNER. Nobody to file it under otherwise.
 *  - OWNER IS NOT ANONYMOUS. This is the whole gate of the slice. A guest's
 *    plan is never archived — not archived-then-deleted, simply never
 *    written, so there is no cleanup story and no window where a guest's
 *    outing sits in someone's database.
 *  - NOT ALREADY ARCHIVED. Conclusion is DERIVED on every read, not fired
 *    once, so without this a completed plan would re-archive on every poll.
 */
export function shouldArchive(itinerary: Itinerary): boolean {
  if (hasBeenDiscarded(itinerary)) return false;
  if (itinerary.status !== "completed") return false;
  if (ownerUidOf(itinerary) === null) return false;
  if (itinerary.ownerIsAnonymous !== false) return false;
  return !hasBeenArchived(itinerary);
}

/** Archived exactly once; the marker rides on the plan itself so the check
 *  survives across serverless instances rather than living in memory. */
export function hasBeenArchived(itinerary: Itinerary): boolean {
  return typeof itinerary.archivedAt === "string" && itinerary.archivedAt.trim().length > 0;
}

/** The history document. Keyed by owner uid at the call site; the plan's own
 *  id is the document id, so a re-archive would overwrite rather than
 *  duplicate even if the guard above were ever bypassed. */
export interface ArchivedPlan {
  itineraryId: string;
  ownerUid: string;
  createdAt: string;
  archivedAt: string;
  timeZone: string | null;
  stops: {
    /** null for a skipped slot, which has no venue. Firestore REJECTS
     *  undefined outright, so every optional field is normalised to null. */
    name: string | null;
    category: string;
    start_time: string | null;
    end_time: string | null;
    status: string;
  }[];
}

/**
 * Project a concluded plan onto its archive record. A projection, not a dump:
 * history needs what the outing WAS, and copying the whole itinerary would
 * drag pools, polylines and provider payloads into a second store with a
 * different retention story.
 */
export function toArchivedPlan(itinerary: Itinerary, archivedAt: string): ArchivedPlan {
  const owner = ownerUidOf(itinerary);
  if (owner === null) {
    throw new Error("toArchivedPlan requires an owned itinerary");
  }
  return {
    itineraryId: itinerary.id,
    ownerUid: owner,
    createdAt: itinerary.createdAt,
    archivedAt,
    timeZone: itinerary.timeZone ?? null,
    stops: itinerary.stops.map((stop) => ({
      name: stop.name ?? null,
      category: stop.category,
      start_time: stop.start_time ?? null,
      end_time: stop.end_time ?? null,
      status: stop.status,
    })),
  };
}
