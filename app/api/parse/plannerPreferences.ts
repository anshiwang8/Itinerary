// Stage 3B — the stored taste profile, projected into what the PLANNER is told.
//
// Stage 3A captured preferences and deliberately spent none of them. This is
// the module that spends them, and it is the only place 3B makes a judgment of
// its own: everything else in the stage is plumbing (the route reads the
// profile for the VERIFIED caller) or wording (the planner prompt says how to
// use what it is handed).
//
// PURE. No Firebase, no fetch, no React — the arrangement `tastePreferences`
// has, for the same reason. The Firestore read is live-only and cannot be
// meaningfully mock-tested; WHAT WE HAND THE MODEL is ordinary branching and
// belongs where a test can pin it without a browser.
//
// The preferences BIAS THE MODEL'S JUDGMENT and nothing else. They are handed
// to the planner as background and the planner decides what to do with them;
// no code here writes `aesthetic`, a searchQuery or a constraint directly.
// That is deliberate and is the core architecture rule: "does this request
// already state a cuisine?" is a semantic question, so the model answers it,
// and its answer goes through the same unchanged validator as any other plan.
//
// FOUR DECISIONS LIVE HERE, and they are why this is a module rather than
// three lines in the route:
//
//  1. A preference the app cannot act on is never sent. `dietary: ["none"]` is
//     the ABSENCE of a restriction and would read to a model like the presence
//     of one; `foods: ["other"]` names no cuisine at all. Both are dropped, and
//     a profile that drops to nothing yields NO injection — not an empty
//     object, which the model would still have to interpret.
//  2. The planner's words are not the survey's words. The phrase table below is
//     a second, small mapping rather than a reuse of `SurveyOption.label`:
//     "Games & competition" is BUTTON COPY, and rewording a button must not
//     silently change how plans are searched. The phrases are also
//     kept short and punctuation-free on purpose — `aesthetic` is prepended
//     VERBATIM into the Places text query (searchPlaces.buildQuery), so a
//     phrase with an em-dash in it is a worse SEARCH, not just a worse
//     sentence.
//  3. A stored dietary preference is SUPPRESSED when the request names a venue
//     type it contradicts — see the dietary section below. This is the one
//     guarantee 3B makes in code rather than in prompt wording.
//  4. An injected ACTIVITY phrase that comes back as a CONSTRAINT is stripped —
//     see isLeakedActivityConstraint at the foot of this file. The second
//     guarantee made in code, added when `activities` shipped, and for the same
//     reason as the third: the failure it prevents is a permanent refusal the
//     user did nothing to earn.
import {
  type TasteDimension,
  type TasteProfilePayload,
} from "../../lib/tastePreferences";
import { dietaryConflictsWithPrompt } from "../../lib/planGuards";
import { normalizeConstraint } from "../../lib/constraints";

/**
 * Real answers that carry NO planning signal, per dimension.
 *
 * "No restrictions" and "Other" are honest things to tick — they just do not
 * survive into a plan. They are listed rather than filtered by heuristic so
 * that adding a survey option forces a decision about it: every option slug
 * must appear either here or in the phrase table, and a test says so.
 */
export const NON_PLANNING_OPTIONS: Readonly<Record<TasteDimension, readonly string[]>> = {
  style: [],
  foods: ["other"],
  dietary: ["none", "other"],
  // Every activity option is actionable by construction — the five that
  // shipped are exactly the ones the planner can reliably steer toward, and an
  // option that could not be steered to was not added rather than added and
  // dropped here.
  activities: [],
};

/** Stored slug → the short phrase the planner is handed. Short and
 *  punctuation-free by policy; see the header note on buildQuery.
 *
 *  The ACTIVITY phrases obey a second rule the others do not: each is a
 *  PLACE KIND, never a venue FEATURE. That is not style — it is what makes the
 *  leak strip safe. "live music" is a genuine, provider-provable constraint
 *  someone may really ask for; "live music venue" is a kind of place and can
 *  never be one, so stripping it can never remove something the user stated.
 *  A phrase here that named a feature would put those two cases on the same
 *  string, and the strip would start eating real requests. */
export const PLANNER_PHRASES: Readonly<
  Record<TasteDimension, Readonly<Record<string, string>>>
> = {
  // PURE VIBE. "cultural" was retired when `activities` shipped: it is an
  // INTEREST, not a vibe, and leaving it here would have steered the same
  // choice twice — once as a query adjective and once as the activity kind.
  style: {
    chill: "low-key",
    lively: "lively",
    trendy: "trendy",
    cozy: "cozy",
    adventurous: "adventurous",
  },
  foods: {
    japanese: "Japanese",
    italian: "Italian",
    mexican: "Mexican",
    korean: "Korean",
    indian: "Indian",
    thai: "Thai",
    chinese: "Chinese",
    mediterranean: "Mediterranean",
  },
  dietary: {
    vegetarian: "vegetarian",
    vegan: "vegan",
    halal: "halal",
    "gluten-free": "gluten-free",
  },
  // A REPRESENTATIVE place kind per interest, not an exhaustive list. The
  // planner is told to use the kind itself or a close sibling, so "art
  // gallery" reaches a museum and "park" reaches a garden or a waterfront
  // trail — the model is the right thing to hold that judgment, and a wider
  // phrase ("art galleries and museums") would be a worse SEARCH on the days
  // the model copies it into a searchQuery verbatim.
  activities: {
    art: "art gallery",
    outdoors: "park",
    games: "board game cafe",
    active: "climbing gym",
    music: "live music venue",
  },
};

/** Map rather than plain-object lookup: the slug is data, and `table["toString"]`
 *  on an object literal returns a function. `normalizeAnswerSet` already
 *  intersects against the closed option set upstream, so this is belt to that
 *  braces — but this function is exported and should not depend on its caller. */
const PHRASE_BY_SLUG: Record<TasteDimension, Map<string, string>> = {
  style: new Map(Object.entries(PLANNER_PHRASES.style)),
  foods: new Map(Object.entries(PLANNER_PHRASES.foods)),
  dietary: new Map(Object.entries(PLANNER_PHRASES.dietary)),
  activities: new Map(Object.entries(PLANNER_PHRASES.activities)),
};

/**
 * What the planner is told about this user, or nothing.
 *
 * Every key is OPTIONAL and an empty dimension is omitted entirely: the model
 * should see a preference or see no mention of it, never an empty list it has
 * to read as "they like no food".
 */
export interface PlannerPreferences {
  style?: string[];
  foods?: string[];
  dietary?: string[];
  /** The KIND of non-food stop this user enjoys — the searchQuery NOUN, not
   *  the `aesthetic` adjective the other three shade. This is the only
   *  dimension that decides WHICH STOP EXISTS. */
  activities?: string[];
}

function phrasesFor(dimension: TasteDimension, slugs: readonly string[] | undefined): string[] {
  const table = PHRASE_BY_SLUG[dimension];
  const phrases: string[] = [];
  for (const slug of slugs ?? []) {
    const phrase = typeof slug === "string" ? table.get(slug) : undefined;
    if (phrase) phrases.push(phrase);
  }
  return phrases;
}

/**
 * A stored profile → the planner's background, or null for "plan exactly as
 * you would for anyone".
 *
 * NULL IS THE IMPORTANT RETURN. A guest, a deployment with no Firebase, a read
 * that failed, a user who skipped the survey, and a user who ticked only "No
 * restrictions" all land here — and every one of them must produce a plan
 * byte-for-byte identical to the one they would have got before this stage
 * existed. That is what keeps mock e2e (which has no Firebase at all) honest:
 * the un-personalized path is not a special case, it is the ordinary one.
 *
 * `surveyCompleted` is deliberately NOT consulted. 3A kept that flag so a
 * deliberate "no preferences" could be told from a dismissal, but both produce
 * an empty answer set and an empty answer set produces no injection either way
 * — reading it here would be a branch with no behaviour behind it.
 *
 * THE PROMPT IS AN ARGUMENT because of dietary. A stored "vegetarian" against
 * a request for "the best steakhouse" is not a contradiction the user made, and
 * `contradictionReason` cannot tell the difference once both are in the parse —
 * it would fail the whole plan loud over a preference the user never restated.
 * So the conflict is settled HERE, one step earlier, by dropping the diet from
 * what the model is even told. The check reuses the contradiction guard's own
 * table, so a pair it refuses can never be a pair we inject.
 *
 * Only the CONFLICTING diet is dropped, not the whole profile: a vegan who also
 * avoids gluten and asks for a steakhouse still gets a gluten-free lean.
 */
export function toPlannerPreferences(
  profile: TasteProfilePayload | null,
  prompt: string
): PlannerPreferences | null {
  if (!profile) return null;

  const style = phrasesFor("style", profile.style);
  const foods = phrasesFor("foods", profile.foods);
  const dietary = phrasesFor("dietary", profile.dietary).filter(
    (diet) => !dietaryConflictsWithPrompt(diet, prompt)
  );
  // No suppression pass for activities, and that is a decision rather than an
  // omission. The dietary one exists because a stored diet plus an explicit
  // venue is a FAIL-LOUD contradiction; an activity preference against a
  // stated activity is an ordinary aspect the request simply wins, which the
  // per-aspect rule in the prompt already settles.
  const activities = phrasesFor("activities", profile.activities);

  if (
    style.length === 0 &&
    foods.length === 0 &&
    dietary.length === 0 &&
    activities.length === 0
  ) {
    return null;
  }

  const preferences: PlannerPreferences = {};
  if (style.length > 0) preferences.style = style;
  if (foods.length > 0) preferences.foods = foods;
  if (dietary.length > 0) preferences.dietary = dietary;
  if (activities.length > 0) preferences.activities = activities;
  return preferences;
}

/**
 * Did an injected ACTIVITY phrase come back as a `constraints` entry?
 *
 * THE FAILURE THIS PREVENTS IS TOTAL, WHICH IS WHY IT IS CODE AND NOT WORDING.
 * `constraints` is ONE plan-level array applied to EVERY slot: `buildQuery`
 * splices it verbatim into every category's Places text query, and
 * `selectVenues` proves each entry from `constraintEvidence` — six provider
 * booleans, and nothing else. A kind of PLACE is unprovable by construction, so
 * a leaked "art gallery" makes `placeMeetsAllConstraints` false for every
 * candidate in every pool: the correction retry fails identically and the whole
 * plan comes back `unmet_constraint`. "Couldn't find a restaurant that's really
 * art gallery" — over a preference the user never restated.
 *
 * This is the same bug, and the same fix, the swap engine already carries for a
 * leaked price word and a leaked category (swap.ts's `isLeakedConstraint`). The
 * planner path had only prompt wording, and CLAUDE.md records that the
 * equivalent dietary wording has been seen to leak live.
 *
 * AN EQUALITY TEST, deliberately, and normalised with `normalizeConstraint` —
 * the SAME function the judge normalises with, so this removes exactly the
 * strings that would have choked it and nothing else. NOT a keyword list, and
 * not a containment test: "live music" is contained in the phrase "live music
 * venue" and is ALSO a genuine, provable constraint a user may really have
 * asked for, so anything looser than equality would start deleting real
 * requests. That the phrases are place kinds rather than features (see
 * PLANNER_PHRASES) is what keeps equality sufficient.
 *
 * KNOWN RESIDUAL, stated rather than papered over: a model that leaks a
 * VARIANT ("art" for "art gallery") is not caught here. The prompt forbids it
 * in as many words, the phrase table keeps the caught case the likely one, and
 * a looser rule would cost more than it saves.
 */
export function isLeakedActivityConstraint(
  constraint: string,
  preferences: PlannerPreferences | null
): boolean {
  const injected = preferences?.activities;
  if (!injected || injected.length === 0) return false;
  const normalized = normalizeConstraint(constraint);
  if (!normalized) return false;
  return injected.some((phrase) => normalizeConstraint(phrase) === normalized);
}
