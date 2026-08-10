// Editing a stored taste profile — the decisions, without the screen.
//
// PURE. No React, no fetch, no Firestore. Same arrangement `tastePreferences.ts`
// has, and for the same reason: the panel itself needs a real signed-in account
// and cannot be reached by mock e2e at all, so everything about it that is
// ordinary branching is lifted out to where a unit test can pin it.
//
// SEPARATE FROM `tastePreferences.ts` on purpose. That file owns what the
// SURVEY asks and what gets FILED — a one-shot capture with no notion of a
// previous answer. Everything here exists only because an editor can be
// re-opened: what the current answers should start as, whether they have been
// changed since, and whether a save actually landed. Folding those into the
// survey's file would widen its remit to cover a screen it knows nothing about,
// which is exactly the split `plannerPreferences.ts` already keeps on the other
// side.
import {
  EMPTY_ANSWERS,
  SURVEY_QUESTIONS,
  answersFromProfile,
  freeTextAnswer,
  profileGateState,
  type TasteAnswers,
} from "./tastePreferences";

/** What the editor needs from `GET /api/profile` before it can show anything. */
export interface ProfileEditLoad {
  /** The stored answers, every dimension present. Empty for a user who has
   *  nothing filed yet — which is a real, editable starting point. */
  answers: TasteAnswers;
  /** The read BROKE, as opposed to there being nothing stored. The editor must
   *  not open on this, and the reason is the no-merge write below. */
  readFailed: boolean;
}

/**
 * The `/api/profile` response → the editor's starting point.
 *
 * `profileGateState` decides what a failed read is, and it decides it here too
 * — one definition, the same one the survey gate gets asked. A second notion of
 * "the read broke" on the editor's side is how the two would drift.
 *
 * A FAILED READ MUST REACH THE SCREEN AS A FAILURE, and this is the load-bearing
 * part. `POST /api/profile` writes with `set` and no merge, and every save sends
 * all four dimensions — so an editor seeded with blanks because the read failed
 * would offer a Save button that erases real answers. It is the same trade
 * `shouldShowSurvey` makes for the same document: on a failed read, do the thing
 * that cannot destroy anything.
 */
export function parseProfileEditLoad(value: unknown): ProfileEditLoad {
  const { state, profile } = profileGateState(value);
  if (state === "failed") return { answers: EMPTY_ANSWERS, readFailed: true };
  // `answersFromProfile` fills every dimension, so a profile written before
  // `activities` existed — or none at all — seeds as "chose nothing" rather
  // than as a missing key. Retired slugs are already gone by this point:
  // `parseTasteProfile` intersects against the closed option set on the way out
  // of storage. It is also the one place the stored `foodsOther` becomes the
  // editor's nested `other`, so the typed cuisine comes back in the box the
  // user typed it into.
  return { answers: answersFromProfile(profile), readFailed: false };
}

/** What a save reports back. The route answers `{ saved: boolean }` and answers
 *  it even when there was nowhere to write — a guest, a deployment with no
 *  Firebase — so `false` is an ordinary answer, not an exception. */
export interface ProfileSaveResult {
  saved: boolean;
}

/** `POST /api/profile`'s body → whether anything was stored. Strict: anything
 *  that is not an explicit `true` is a save that did not happen, because the
 *  screen says "Saved" on the strength of this and must never say it wrongly. */
export function parseSaveResult(value: unknown): ProfileSaveResult {
  const saved =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).saved === true;
  return { saved };
}

/** Two answer sets for one dimension, compared as SETS. Order is not meaning
 *  here: the same three chips clicked in a different sequence are the same
 *  answer, and the stored record proves it — `normalizeAnswerSet` re-emits
 *  everything in the question's own order on the way in and out of storage. */
function sameChoices(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const chosen = new Set(a);
  return b.every((value) => chosen.has(value));
}

/**
 * Are these the same answers?
 *
 * Iterates SURVEY_QUESTIONS rather than the object's own keys, the habit
 * `EMPTY_ANSWERS` and `isEmptyAnswers` already keep: a fifth dimension is then
 * covered by adding it to the survey, with nothing here to remember.
 *
 * THE FREE TEXT IS COMPARED SANITIZED, and that is the honest definition of
 * dirty for it: this flag answers "would saving change what is stored", and
 * what would be stored is the sanitized form. Typing a "!" after a cuisine
 * that is already filed changes nothing, so it must not light up Save or
 * trigger a discard prompt — while "Thai" over "Ethiopian" plainly does.
 * Comparing raw would make both dirty; comparing nothing would make neither.
 */
export function answersEqual(a: TasteAnswers, b: TasteAnswers): boolean {
  return (
    SURVEY_QUESTIONS.every((question) => sameChoices(a[question.id], b[question.id])) &&
    freeTextAnswer(a) === freeTextAnswer(b)
  );
}

/**
 * Has the user changed anything since the panel opened (or since their last
 * successful save)?
 *
 * This is the whole input to the confirm-on-discard: CLEAN closes immediately,
 * because interrupting someone who changed nothing is a dialog that only ever
 * gets in the way, and DIRTY asks, because the alternative is silently throwing
 * away work on an Escape keypress. A successful save makes what was saved the
 * new `seed`, so closing right after saving is clean.
 */
export function answersDirty(seed: TasteAnswers, current: TasteAnswers): boolean {
  return !answersEqual(seed, current);
}
