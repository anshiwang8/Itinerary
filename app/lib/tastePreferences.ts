// The onboarding taste survey: what it asks, who sees it, and what gets stored.
//
// PURE. No Firebase, no Firestore, no fetch, no React. Same arrangement
// `ownership.ts` has: the Firestore write itself is live-only and can't be
// meaningfully mock-tested, but the DECISIONS around it — should this person be
// asked at all, and what exactly do we file — are ordinary branching, so they
// live here where `tastePreferences.test.ts` can pin them.
//
// CAPTURE ONLY — still true of THIS FILE, and no longer true of the profile.
// Stage 3B opened the boundary 3A drew here: the planner is now told what a
// signed-in user likes. What did NOT move is where that decision lives. This
// module still exports no "apply" of any kind; the projection from a stored
// profile to what the model is handed is `api/parse/plannerPreferences.ts`,
// beside the planner that spends it, so "what the survey means" and "what the
// survey stores" stay two separate, separately-testable things.
//
// Both sides use this file, exactly as `historyView` is used by both: the
// SERVER normalises a submission before it writes and a document before it goes
// on the wire, and the CLIENT runs the same functions over the response. One
// definition of a valid answer set; a second copy is how the two would drift.

/** One selectable answer. The stored value is a SLUG, not the label: rewording
 *  "Chill & low-key" must not silently orphan every record that chose it. */
export interface SurveyOption {
  value: string;
  label: string;
}

/** The four dimensions, in the order they are asked. Each is MULTI-SELECT and
 *  each is optional — a question left blank stores an empty array, which is a
 *  real answer ("they were asked and chose nothing"), not a missing one. */
export interface SurveyQuestion {
  /** matches the key on TasteAnswers and the field name in Firestore */
  id: TasteDimension;
  question: string;
  options: SurveyOption[];
}

export type TasteDimension = "style" | "foods" | "dietary" | "activities";

const option = (value: string, label: string): SurveyOption => ({ value, label });

export const SURVEY_QUESTIONS: readonly SurveyQuestion[] = [
  {
    id: "style",
    question: "What's your style?",
    options: [
      option("chill", "Chill & low-key"),
      option("lively", "Lively & social"),
      option("trendy", "Trendy & stylish"),
      option("cozy", "Cozy & intimate"),
      option("adventurous", "Adventurous"),
      // "cultural" was RETIRED when the activities question shipped. It was an
      // INTEREST wearing a vibe's clothes, and it now has a real home: style
      // shades the venue a stop lands on, activities decides which stop
      // exists, and keeping "cultural" here would have steered the same choice
      // through both. Retiring a slug is safe by construction —
      // `normalizeAnswerSet` intersects against the options below, so a stored
      // "cultural" is dropped the moment an old profile is read.
    ],
  },
  {
    id: "foods",
    question: "Favorite foods",
    options: [
      option("japanese", "Japanese"),
      option("italian", "Italian"),
      option("mexican", "Mexican"),
      option("korean", "Korean"),
      option("indian", "Indian"),
      option("thai", "Thai"),
      option("chinese", "Chinese"),
      option("mediterranean", "Mediterranean"),
      option("other", "Other"),
    ],
  },
  {
    id: "dietary",
    question: "Any dietary restrictions?",
    options: [
      option("none", "No restrictions"),
      option("vegetarian", "Vegetarian"),
      option("vegan", "Vegan"),
      option("halal", "Halal"),
      option("gluten-free", "Gluten-free"),
      option("other", "Other"),
    ],
  },
  {
    // FIVE OPTIONS, AND THE SHORTNESS IS THE POINT. Every option here is one
    // the planner can actually steer a vague plan toward: each maps to a place
    // KIND that searches cleanly, carries a sensible length, and is not
    // weather- or schedule-broken. Theatre and shows, classes and workshops,
    // nightlife, shopping and spas were all considered and left out — a
    // theatre or a class is a SHOWTIME product and this app has no showtimes,
    // and nightlife pulls against the variety caps the planner applies to an
    // un-named day. Asking a question whose answer nothing can act on is how
    // the profile fills up with dead weight, so an option that cannot be
    // steered to is not collected.
    //
    // There is deliberately no "Other": it would name no kind, so it could
    // only ever be dropped (`NON_PLANNING_OPTIONS`), and offering a choice
    // that is discarded on read is worse than not offering it.
    id: "activities",
    question: "What do you like to do?",
    options: [
      option("art", "Art & museums"),
      option("outdoors", "Outdoors & nature"),
      option("games", "Games & competition"),
      option("active", "Active & sporty"),
      option("music", "Live music"),
    ],
  },
] as const;

/** One answer set per dimension. Always all three keys, always an array. */
export type TasteAnswers = Record<TasteDimension, string[]>;

export const EMPTY_ANSWERS: TasteAnswers = {
  style: [],
  foods: [],
  dietary: [],
  activities: [],
};

const QUESTION_BY_ID = new Map(SURVEY_QUESTIONS.map((q) => [q.id, q]));

/**
 * An answer set narrowed to what the survey actually offers.
 *
 * The options are a CLOSED SET, so anything else is either a stale client or a
 * hand-rolled request, and neither earns a place in the record. Unknown values
 * are dropped rather than rejected: a submission is a one-shot capture the user
 * cannot retry, so keeping the five good answers beats failing all six. Output
 * order is the QUESTION's order, not the order they were clicked, so two
 * records with the same answers compare equal.
 */
export function normalizeAnswerSet(dimension: TasteDimension, raw: unknown): string[] {
  const question = QUESTION_BY_ID.get(dimension);
  if (!question || !Array.isArray(raw)) return [];
  const chosen = new Set(
    raw.filter((value): value is string => typeof value === "string").map((v) => v.trim())
  );
  return question.options.map((o) => o.value).filter((value) => chosen.has(value));
}

/** Every dimension normalised. Missing keys become empty arrays — Firestore
 *  rejects `undefined` outright, the same reason `toArchivedPlan` normalises
 *  each optional stop field to null. */
export function normalizeTasteAnswers(raw: unknown): TasteAnswers {
  const source: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    style: normalizeAnswerSet("style", source.style),
    foods: normalizeAnswerSet("foods", source.foods),
    dietary: normalizeAnswerSet("dietary", source.dietary),
    activities: normalizeAnswerSet("activities", source.activities),
  };
}

/** True when the user selected nothing at all — a submit that answered no
 *  question. Stored as such; it is still a completed survey. */
export function isEmptyAnswers(answers: TasteAnswers): boolean {
  return SURVEY_QUESTIONS.every((q) => answers[q.id].length === 0);
}

/**
 * The stored profile — ONE document per user at `users/<uid>/profile/preferences`.
 *
 * TWO flags, not one, and the distinction is worth the extra field:
 *  - `surveySeen` is the GATE. True the moment the survey is answered OR
 *    skipped, which is what stops it reappearing on the next login. A skip has
 *    to write something, or "skip" would mean "ask me again forever".
 *  - `surveyCompleted` records WHICH of those happened. It gates nothing today.
 *    It exists because "skipped" and "submitted with nothing ticked" produce
 *    identical answer sets, and 3B will want to tell a deliberate "no
 *    preferences" from a dismissal it never earned an answer to.
 */
export interface TasteProfileDocument {
  ownerUid: string;
  style: string[];
  foods: string[];
  dietary: string[];
  /** The KINDS of non-food thing this user enjoys. Added after style/foods/
   *  dietary, so a document written before it simply has no field — which
   *  `parseTasteProfile` reads as the empty set, the same answer a user who
   *  ticked nothing gives. No migration, no backfill. */
  activities: string[];
  surveySeen: boolean;
  surveyCompleted: boolean;
  /** ISO instant, absolute — like every other timestamp this app files. */
  updatedAt: string;
}

/**
 * The wire payload: the stored record MINUS the owner uid.
 *
 * Typed off `TasteProfileDocument` rather than redeclared, so a write-side
 * shape change breaks the COMPILE instead of quietly serving a field the
 * reader stopped understanding — the arrangement `HistoryPlanPayload` has.
 * `ownerUid` is dropped because the caller IS the owner: it is the one field
 * the reader already knows, and echoing it back invites treating it as input.
 */
export type TasteProfilePayload = Omit<TasteProfileDocument, "ownerUid">;

/**
 * Answers → the document to file. The ONLY place this shape is built.
 *
 * `surveySeen` is hardcoded true: this function is called from exactly two
 * places, a submit and a skip, and both mean "they have now been asked". There
 * is deliberately no parameter for it — a caller able to write `seen: false`
 * could resurrect the nag, and no caller has a reason to.
 */
export function toTasteProfileDocument(
  uid: string,
  answers: TasteAnswers,
  options: { completed: boolean; updatedAt: string }
): TasteProfileDocument {
  const normalized = normalizeTasteAnswers(answers);
  return {
    ownerUid: uid.trim(),
    style: normalized.style,
    foods: normalized.foods,
    dietary: normalized.dietary,
    activities: normalized.activities,
    surveySeen: true,
    surveyCompleted: options.completed,
    updatedAt: options.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored document → the wire payload, or null when it cannot be one.
 *
 * KEEP-ON-MISSING-DATA, like `parseHistoryPlan`: a record with a broken answer
 * array still counts as a record, because the field that matters to the gate is
 * `surveySeen`. Only a value that is not an object at all is nothing.
 *
 * `surveySeen` is read strictly (`=== true`) so a malformed document fails
 * SAFE in the direction that costs least — the survey is offered again, which
 * is a mild annoyance, rather than the profile being treated as present and the
 * user never being asked at all.
 */
export function parseTasteProfile(value: unknown): TasteProfilePayload | null {
  if (!isRecord(value)) return null;
  return {
    style: normalizeAnswerSet("style", value.style),
    foods: normalizeAnswerSet("foods", value.foods),
    dietary: normalizeAnswerSet("dietary", value.dietary),
    activities: normalizeAnswerSet("activities", value.activities),
    surveySeen: value.surveySeen === true,
    surveyCompleted: value.surveyCompleted === true,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

// ── the "should we show this" decision ───────────────────────────────────

/** Mirrors useAuth's AuthStatus structurally rather than importing it: this
 *  file is pure, and useAuth pulls in the Firebase SDK. Same reason
 *  `FirebaseUserLike` is declared structurally in authUser.ts. */
export type SurveyAuthStatus = "loading" | "signed-in" | "signed-out";

/** What the client knows about the caller's stored profile. "unknown" is the
 *  state before the read lands, and it is NOT the same as "absent" — showing a
 *  survey during that gap is how a returning user gets asked twice. */
export type ProfileGateState = "unknown" | "absent" | "present" | "failed";

export interface SurveyGateInput {
  authStatus: SurveyAuthStatus;
  /** From AppUser.isAnonymous, which defaults TRUE when the provider does not
   *  say. Null when there is no user at all. */
  isAnonymous: boolean | null;
  profile: ProfileGateState;
  /** Set once the survey has been shown in THIS session, so a profile write
   *  that is still in flight cannot let it mount a second time. */
  alreadyShown: boolean;
}

/**
 * Show the onboarding survey?
 *
 * Every "no" here is a distinct case someone would otherwise hit:
 *
 *  - LOADING / SIGNED-OUT: nobody to file a profile under yet. Since 1B every
 *    visitor is signed in within a moment, so this is a gap of milliseconds —
 *    but a survey that flashes during it would be asked of a guest.
 *  - ANONYMOUS: a guest. There is no account to save to, and 3A adds none. The
 *    check is `!== false`, matching AppUser's own bias: an unclear provider
 *    payload reads as a guest, and the cost of that mistake is a survey not
 *    shown rather than a profile written for someone who never signed in.
 *  - PROFILE PRESENT: a returning user, whether they answered or skipped.
 *    `surveySeen` is written by both paths precisely so this branch cannot
 *    tell them apart.
 *  - PROFILE UNKNOWN: the read has not landed. Wait for it.
 *  - PROFILE FAILED: the read broke. Do NOT show — a survey shown on a failed
 *    read is a survey shown to a returning user who already answered it, and
 *    the write that would follow could overwrite real preferences with a fresh
 *    blank set. Skipping the ask costs one onboarding; the alternative costs
 *    someone's data.
 */
export function shouldShowSurvey(input: SurveyGateInput): boolean {
  if (input.alreadyShown) return false;
  if (input.authStatus !== "signed-in") return false;
  if (input.isAnonymous !== false) return false;
  return input.profile === "absent";
}

/** The `/api/profile` response → the gate state. An unreadable body is a FAILED
 *  read, never an absent profile, for the reason spelled out above. */
export function profileGateState(value: unknown): {
  state: ProfileGateState;
  profile: TasteProfilePayload | null;
} {
  if (!isRecord(value) || value.readFailed === true) {
    return { state: "failed", profile: null };
  }
  const profile = parseTasteProfile(value.profile);
  // A document that exists but was never marked seen is treated as absent: the
  // only writer sets the flag, so this can only be a partial or foreign record,
  // and asking again is the recoverable direction.
  if (!profile || !profile.surveySeen) return { state: "absent", profile: null };
  return { state: "present", profile };
}
