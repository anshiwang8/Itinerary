// The taste profile in Firestore — the write, and the read that gates it.
//
// Both directions live here for the same reason both directions of history live
// in one file: `profileDoc` is the ONE place the path
// `users/<uid>/profile/preferences` is spelled. A second copy of that path
// somewhere else would be a second copy of the same rule, free to drift.
//
// ONE DOCUMENT PER USER, at a fixed id. History is keyed by itinerary id
// because there are many; a profile is singular, so the id is a constant and
// every write is an overwrite of the same record. That is what makes a re-ask
// impossible to duplicate.
//
// NEVER THROWS, either way. The write is the tail of an onboarding the user has
// already finished with; the read decides whether to ask a question. Neither is
// worth failing a request over, and mock e2e runs with no Firebase at all —
// there, both simply report "nothing", which is the truth.
import { getAdminFirestore } from "../../lib/firebaseAdmin";
import { logEvent } from "../_shared/http";
import {
  parseTasteProfile,
  toTasteProfileDocument,
  type TasteAnswers,
  type TasteProfilePayload,
} from "../../lib/tastePreferences";

/** `users/<uid>/profile/preferences`. Null when Firestore is unavailable;
 *  every caller treats that as "cannot, so don't", never as an error. */
function profileDoc(uid: string) {
  const db = getAdminFirestore();
  return db
    ? db.collection("users").doc(uid).collection("profile").doc("preferences")
    : null;
}

export interface ProfileReadResult {
  profile: TasteProfilePayload | null;
  /** The query itself failed, as opposed to there being no profile. The two
   *  look identical on the wire and must not: treating a failed read as "no
   *  profile" would re-ask a returning user and then overwrite the answers
   *  they already gave. */
  readFailed: boolean;
}

/**
 * One user's stored profile.
 *
 * The uid is always the VERIFIED caller's — this function is never handed one
 * from a request, the same trust boundary `readHistoryForOwner` keeps.
 */
export async function readTasteProfile(uid: string): Promise<ProfileReadResult> {
  const owner = uid.trim();
  if (owner.length === 0) return { profile: null, readFailed: false };

  const doc = profileDoc(owner);
  if (!doc) {
    // No Firebase configured. NOT a failure: mock e2e and any deployment
    // without Admin credentials live here permanently, and in both the honest
    // answer is that there is no profile. Reporting `readFailed` would suppress
    // the survey everywhere Firebase is absent — correct for a broken query,
    // wrong for a deployment that simply has no Firestore.
    return { profile: null, readFailed: false };
  }

  try {
    const snapshot = await doc.get();
    if (!snapshot.exists) return { profile: null, readFailed: false };
    return { profile: parseTasteProfile(snapshot.data()), readFailed: false };
  } catch (error) {
    logEvent("error", "profile_read_failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    return { profile: null, readFailed: true };
  }
}

/**
 * File a user's survey result. Returns whether anything was written.
 *
 * Called on BOTH paths — a submit and a skip — because a skip has to be
 * recorded or it would mean "ask me again next time". `toTasteProfileDocument`
 * is what encodes that: it always sets `surveySeen`, and takes only whether the
 * survey was completed.
 *
 * `set` without merge, deliberately: this is the whole profile, and a partial
 * merge could leave a previous stage's stale answer set beside a new one.
 */
export async function writeTasteProfile(
  uid: string,
  answers: TasteAnswers,
  completed: boolean
): Promise<boolean> {
  const owner = uid.trim();
  if (owner.length === 0) return false;

  const doc = profileDoc(owner);
  if (!doc) {
    // Unconfigured Firebase. Logged at info, not error: this is the ordinary
    // state of mock e2e, and a survey that cannot be saved must not look like
    // a fault in the runs where saving was never possible.
    logEvent("info", "profile_write_skipped", { reason: "firestore_unavailable" });
    return false;
  }

  try {
    await doc.set(
      toTasteProfileDocument(owner, answers, {
        completed,
        updatedAt: new Date().toISOString(),
      })
    );
    logEvent("info", "profile_written", { completed });
    return true;
  } catch (error) {
    logEvent("error", "profile_write_failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
