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

/** The slug both "Other" chips store. Named rather than spelled at each use:
 *  it is the one option value that means something to code. */
export const OTHER_OPTION = "other";

/**
 * The ONE dimension whose "Other" opens a text box, and the shortness of that
 * list is the same decision the activities question already records.
 *
 * FOODS ONLY, because a typed cuisine is the only free text this app can act
 * on. It reaches the planner as one more entry in `preferences.foods`,
 * indistinguishable from a curated one, and becomes "<cuisine> restaurant" —
 * a searchQuery. Nothing else here clears that bar:
 *  - ACTIVITIES has no "Other" at all, deliberately, and giving it one would
 *    break the constraint-leak strip: that strip is an EQUALITY test against
 *    the phrases WE injected (plannerPreferences.isLeakedActivityConstraint),
 *    and it is safe only because every injected activity phrase is a place
 *    KIND that can never be a provable constraint. A user-typed activity is
 *    free to be "live music" — a real, provable constraint — and stripping it
 *    would start deleting things people actually asked for.
 *  - DIETARY's "Other" is a restriction, and an unverified typed one is a
 *    claim about safety spliced into a search. The curated four are the ones
 *    the contradiction table knows how to reason about.
 */
export const FREE_TEXT_DIMENSION: TasteDimension = "foods";

/**
 * The hard cap on a stored free-text answer, in characters.
 *
 * A cuisine is one or two words — "Ethiopian", "Trinidadian roti" — so 40 is
 * generous for every real answer and still a ceiling. The ceiling is the
 * point: this string is filed on a profile the planner reads back on EVERY
 * plan and hands to the model, so an unbounded field is an unbounded payload
 * on the hot path. `readJsonBody`'s byte limit stops the extreme case at the
 * door; this stops the merely silly one from being stored at all.
 */
export const MAX_FREE_TEXT_LENGTH = 40;

/** Leading/trailing space or hyphen. Legal characters, but not a legal START:
 *  the phrase invariant demands a letter first. */
const EDGE_SEPARATORS = /^[\s-]+|[\s-]+$/g;

/**
 * Free text → the same shape the curated phrases have, or "".
 *
 * THE INVARIANT IS NOT COSMETIC. A projected preference is handed to the model
 * and can be copied into a Places text query verbatim (`buildQuery` prepends
 * `aesthetic` and splices `constraints` in as written), which is why
 * `PLANNER_PHRASES` are punctuation-free and why a test pins them against
 * `/^[A-Za-z][A-Za-z -]*$/`. A curated phrase satisfies that because a human
 * wrote it; typed text has to be MADE to, and this is the one place that
 * happens. Everything outside letters, spaces and hyphens becomes a space
 * rather than vanishing — "thai/korean" is two words, not one invented one —
 * runs collapse, the ends are trimmed of separators, and the result is capped.
 *
 * The cap is applied BEFORE the final trim, because a cut lands wherever it
 * lands and must not be allowed to leave a trailing separator behind.
 *
 * EMPTY IS UNSET. Text that sanitizes to nothing ("!!!", "   ", 12345) is the
 * same as never having typed anything, and every caller treats it that way.
 */
export function normalizeFreeText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/[^A-Za-z -]+/g, " ")
    .replace(/-{2,}/g, "-")
    .replace(/\s+/g, " ")
    .replace(EDGE_SEPARATORS, "");
  return cleaned.slice(0, MAX_FREE_TEXT_LENGTH).replace(EDGE_SEPARATORS, "");
}

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

/**
 * One answer set per dimension. Always all four keys, always an array.
 *
 * `other` is the EDITABLE companion to those arrays, and it is a separate,
 * nested, optional key rather than a fifth entry for one reason: the four
 * above are `string[]` drawn from a CLOSED SET, and `normalizeAnswerSet`
 * guarantees that closure. Typed text is neither, so it is kept somewhere the
 * closed-set guarantee is not being claimed — `answers[question.id]` still
 * means exactly what it meant, and every consumer that maps over
 * SURVEY_QUESTIONS is untouched.
 *
 * OMITTED WHEN EMPTY, like `PlannerPreferences`' own dimensions: an answer set
 * with nothing typed has no `other` key at all, so `EMPTY_ANSWERS` is still
 * literally the empty answer set and two records with the same answers still
 * compare equal.
 *
 * A `Partial<Record<TasteDimension, …>>` rather than a lone `foods` string,
 * because the SHAPE should not have to change if a second dimension ever earns
 * a text box. Only `FREE_TEXT_DIMENSION` is ever read — see the note there for
 * why that is one dimension and not four.
 */
export interface TasteAnswers extends Record<TasteDimension, string[]> {
  other?: Partial<Record<TasteDimension, string>>;
}

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

/**
 * Every dimension normalised. Missing keys become empty arrays — Firestore
 * rejects `undefined` outright, the same reason `toArchivedPlan` normalises
 * each optional stop field to null.
 *
 * THIS IS ALSO WHERE FREE TEXT IS GATED, and it is the only place. The text
 * box exists only while the "Other" chip is pressed, so text left behind by a
 * chip that has since been un-pressed is text the user cannot see — and a
 * preference nobody can see steering their plans is the worst version of this
 * feature. Un-ticking "Other" and saving therefore clears it, which is what
 * the disappearing box already told them would happen.
 *
 * Everything writes through here (`POST /api/profile` normalises the body,
 * `toTasteProfileDocument` normalises again on the way to the document), so
 * the gate holds for every stored record. Nothing downstream re-checks it.
 */
export function normalizeTasteAnswers(raw: unknown): TasteAnswers {
  const source: Record<string, unknown> = isRecord(raw) ? raw : {};
  const answers: TasteAnswers = {
    style: normalizeAnswerSet("style", source.style),
    foods: normalizeAnswerSet("foods", source.foods),
    dietary: normalizeAnswerSet("dietary", source.dietary),
    activities: normalizeAnswerSet("activities", source.activities),
  };
  const typed = gatedFreeText(answers[FREE_TEXT_DIMENSION], source.other);
  if (typed) answers.other = { [FREE_TEXT_DIMENSION]: typed };
  return answers;
}

/** THE gate, in one function with two callers, because two copies of "is the
 *  Other chip on" would be free to drift and the whole point of the rule is
 *  that storage and the screen agree about it. */
function gatedFreeText(chosen: readonly string[], rawOther: unknown): string {
  if (!chosen.includes(OTHER_OPTION)) return "";
  const bag = isRecord(rawOther) ? rawOther : {};
  return normalizeFreeText(bag[FREE_TEXT_DIMENSION]);
}

/** The sanitized, gated free text on an answer set, or "". One reader, so no
 *  caller has to know the key is nested, that it may be absent, or that text
 *  behind an un-pressed "Other" chip does not count. */
export function freeTextAnswer(answers: TasteAnswers): string {
  return gatedFreeText(answers[FREE_TEXT_DIMENSION], answers.other);
}

/** True when the user selected nothing at all — a submit that answered no
 *  question. Stored as such; it is still a completed survey. (Typed text needs
 *  no clause of its own: it only counts while "Other" is pressed, and that
 *  chip already makes the foods set non-empty.) */
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
  /**
   * The cuisine typed into the foods question's "Other" box, sanitized, or "".
   *
   * A SIBLING FIELD, NOT A FIFTH ENTRY IN `foods`. The four arrays above are
   * closed sets and `normalizeAnswerSet` is what guarantees it — dropping a
   * free string in among them would quietly end that guarantee for the one
   * dimension it matters most in. Kept flat rather than nested because that is
   * how every other field on this document is stored.
   *
   * ALWAYS A STRING, never undefined: Firestore rejects undefined outright,
   * exactly as it does for the empty answer arrays. A document written before
   * this field existed simply has no key, which `parseTasteProfile` reads as
   * "" — the same answer someone who typed nothing gives. No migration.
   */
  foodsOther: string;
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
    // Sanitized and gated by the normaliser above; "" whenever "Other" is not
    // among the foods, which is what makes the gate hold for every record.
    foodsOther: freeTextAnswer(normalized),
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
    // Sanitized on the way OUT of storage as well as in, the habit
    // `normalizeAnswerSet` keeps: a record is only ever as trustworthy as the
    // client that wrote it, and this string is handed to the planner. Absent
    // (every pre-2026-08-09 document) reads as "".
    foodsOther: normalizeFreeText(value.foodsOther),
    surveySeen: value.surveySeen === true,
    surveyCompleted: value.surveyCompleted === true,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

/**
 * A stored profile → the EDITABLE answer set, free text included.
 *
 * The two shapes differ in exactly one place: the document keeps `foodsOther`
 * flat beside the arrays, and an editor keeps it nested under `other` where the
 * closed-set guarantee is not being claimed. This is the one function that
 * knows both, so no screen has to.
 *
 * Funnelled through `normalizeTasteAnswers`, which means the "Other" gate
 * applies here too: a record with text but no "other" chip seeds without it,
 * rather than showing a box the user cannot see a chip for.
 */
export function answersFromProfile(profile: TasteProfilePayload | null): TasteAnswers {
  if (!profile) return normalizeTasteAnswers(null);
  return normalizeTasteAnswers({
    ...profile,
    other: { [FREE_TEXT_DIMENSION]: profile.foodsOther },
  });
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

/** Blank is absent, the rule `ownerUidOf` and `toAppUser` both apply: a uid is
 *  either a real identity or it is nothing. */
function uidOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Has the person the survey state describes CHANGED?
 *
 * `alreadyShown` above and the profile read that feeds `profile` are both
 * PER-USER facts held for the length of a PAGE SESSION, and a page session can
 * outlive a user: sign out, sign in as someone else, and the latch still says
 * "asked" while the gate still holds the previous account's profile. That is
 * the whole bug this answers — the second account was never asked, and a
 * refresh "fixed" it because a refresh is how the session ended.
 *
 * Keyed on the UID and nothing else, for the same reason `sameAppUserIdentity`
 * exists: `useAuth` watches `onIdTokenChanged`, which also fires on every
 * hourly refresh and on every `getIdToken()` that renews. Re-arming on each of
 * those would re-open the survey mid-session for someone who just answered it.
 * A refresh carries the same uid, so it is inert here by construction.
 *
 * Two "no"s beyond that, and both are real states rather than defensive noise:
 *  - NO CURRENT UID. The moment between `signOut()` and the anonymous sign-in
 *    that replaces it, when the observer has delivered null. Nobody to arm for,
 *    and the previous uid is KEPT by the caller so the identity that arrives
 *    next is still compared against a real predecessor, not against null.
 *  - NO PREVIOUS UID. The first identity of the session. Nothing has been shown
 *    and nothing has been read, so there is nothing to re-arm; recording it is
 *    the caller's whole job on that pass.
 *
 * Note what is NOT special-cased: a guest. Signing out mints a BRAND-NEW
 * anonymous uid, so the guest → guest hop between two accounts is a genuine
 * identity change and is exactly where the re-arm lands on the ordinary path.
 */
export function shouldRearmSurvey(
  previousUid: string | null | undefined,
  currentUid: string | null | undefined
): boolean {
  const current = uidOrNull(currentUid);
  if (current === null) return false;
  const previous = uidOrNull(previousUid);
  if (previous === null) return false;
  return previous !== current;
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
