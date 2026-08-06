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
// THREE DECISIONS LIVE HERE, and they are why this is a module rather than
// three lines in the route:
//
//  1. A preference the app cannot act on is never sent. `dietary: ["none"]` is
//     the ABSENCE of a restriction and would read to a model like the presence
//     of one; `foods: ["other"]` names no cuisine at all. Both are dropped, and
//     a profile that drops to nothing yields NO injection — not an empty
//     object, which the model would still have to interpret.
//  2. The planner's words are not the survey's words. The phrase table below is
//     a second, small mapping rather than a reuse of `SurveyOption.label`:
//     "Cultural (art, music, history)" is BUTTON COPY, and rewording a button
//     must not silently change how plans are searched. The phrases are also
//     kept short and punctuation-free on purpose — `aesthetic` is prepended
//     VERBATIM into the Places text query (searchPlaces.buildQuery), so a
//     phrase with an em-dash in it is a worse SEARCH, not just a worse
//     sentence.
//  3. A stored dietary preference is SUPPRESSED when the request names a venue
//     type it contradicts — see the dietary section below. This is the one
//     guarantee 3B makes in code rather than in prompt wording.
import {
  type TasteDimension,
  type TasteProfilePayload,
} from "../../lib/tastePreferences";
import { dietaryConflictsWithPrompt } from "../../lib/planGuards";

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
};

/** Stored slug → the short phrase the planner is handed. Short and
 *  punctuation-free by policy; see the header note on buildQuery. */
export const PLANNER_PHRASES: Readonly<
  Record<TasteDimension, Readonly<Record<string, string>>>
> = {
  style: {
    chill: "low-key",
    lively: "lively",
    trendy: "trendy",
    cozy: "cozy",
    adventurous: "adventurous",
    cultural: "cultural",
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
};

/** Map rather than plain-object lookup: the slug is data, and `table["toString"]`
 *  on an object literal returns a function. `normalizeAnswerSet` already
 *  intersects against the closed option set upstream, so this is belt to that
 *  braces — but this function is exported and should not depend on its caller. */
const PHRASE_BY_SLUG: Record<TasteDimension, Map<string, string>> = {
  style: new Map(Object.entries(PLANNER_PHRASES.style)),
  foods: new Map(Object.entries(PLANNER_PHRASES.foods)),
  dietary: new Map(Object.entries(PLANNER_PHRASES.dietary)),
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

  if (style.length === 0 && foods.length === 0 && dietary.length === 0) return null;

  const preferences: PlannerPreferences = {};
  if (style.length > 0) preferences.style = style;
  if (foods.length > 0) preferences.foods = foods;
  if (dietary.length > 0) preferences.dietary = dietary;
  return preferences;
}
