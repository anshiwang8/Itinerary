// Lightweight clarifying questions — pure, rule-based, NO LLM call (the
// LLM does semantic work; deciding whether to ask is a deterministic
// field check). Given a parse, return 0–3 targeted questions to show
// before search/select. No accounts, no profiles — deliberately deferred.
import { ParsedPrompt } from "../api/places/search/filter";

export interface ClarifyQuestion {
  id: "kind" | "when" | "vibe" | "narrow";
  question: string;
  /** quick-pick chips; the UI also allows free text */
  options: string[];
  /** narrow only: the generic category this question narrows ("restaurant",
   * "bar", …) — the answer folds back onto exactly this signal */
  category?: string;
}

// ── category SPECIFICITY (a second axis alongside category presence) ──
// "restaurant tonight" used to skip clarification entirely: category
// present, time present, done. But a bare "restaurant" is nowhere near
// enough to search well — the useful question isn't WHETHER they named a
// category, it's whether the one they named is a genuinely generic term
// with real narrower options. Each rule pairs a generic pattern with a
// SPECIFIC guard: when the category (or a constraint) already carries a
// narrowing term, we never re-ask — the parse contract already keeps
// dish/cuisine words as their own category ("ramen" stays "ramen").
interface GenericRule {
  /** the bare/generic term that warrants narrowing */
  generic: RegExp;
  /** already-specific evidence — category or constraints matching this skip the question */
  specific: RegExp;
  question: string;
  options: string[];
  /** how an answer folds back onto the category: a cuisine is a MODIFIER
   * ("Italian" + "restaurant" → "Italian restaurant"), while an activity/
   * venue-type answer IS the category ("bar" → "cocktail bar") */
  mode: "prefix" | "replace";
}

const GENERIC_RULES: GenericRule[] = [
  {
    generic: /\b(restaurants?|dinner|lunch|food|meal)\b/i,
    specific:
      /italian|japanese|mexican|chinese|thai|indian|korean|vietnamese|french|greek|mediterranean|american|bbq|barbecue|seafood|sushi|ramen|pizza|taco|burger|noodle|pho|steak|dumpling|shawarma|curry|pasta|izakaya|brunch|breakfast|fast food|vegan|vegetarian/i,
    question: "What are you craving?",
    options: [
      "Italian", "Japanese", "Mexican", "Chinese", "Thai", "Indian",
      "Mediterranean", "American", "fast food", "BBQ", "seafood",
    ],
    mode: "prefix",
  },
  {
    generic: /\b(something to do|things to do|entertainment|activity|activities)\b/i,
    specific:
      /arcade|bowling|mini ?golf|escape room|movie|cinema|museum|galler|comedy|live music|karaoke|axe|climbing|skating/i,
    question: "What kind of thing?",
    options: [
      "arcade", "bowling", "mini golf", "escape room", "movie theater",
      "museum", "comedy show", "live music", "karaoke",
    ],
    mode: "replace",
  },
  {
    generic: /\b(bars?|drinks?)\b/i,
    specific: /cocktail|sports bar|dive|wine|brewery|rooftop|speakeasy|pub|club|izakaya/i,
    question: "What kind of bar?",
    options: [
      "cocktail bar", "sports bar", "dive bar", "wine bar", "brewery",
      "rooftop bar", "speakeasy",
    ],
    mode: "replace",
  },
  {
    generic: /\b(desserts?|something sweet)\b/i,
    specific: /ice ?cream|gelato|bakery|boba|donut|doughnut|cake|patisserie|creamery/i,
    question: "What sounds good?",
    options: ["ice cream", "bakery", "boba", "donuts", "cafe dessert"],
    mode: "replace",
  },
  {
    generic: /\b(shopping|shops?|stores?)\b/i,
    specific: /thrift|vintage|mall|bookstore|boutique|market|record/i,
    question: "What kind of shopping?",
    options: ["thrift store", "mall", "bookstore", "boutique", "market"],
    mode: "replace",
  },
];

/**
 * The narrowing question for ONE category signal, or null when the term is
 * either not generic or already specific. The specific guard checks the
 * category AND the constraints, so "restaurant" with a "vegan" constraint
 * (which already narrows the search query) is not re-asked.
 */
export function genericCategoryQuestion(
  category: string,
  constraints: string[] = []
): ClarifyQuestion | null {
  const c = (category ?? "").trim();
  if (!c) return null;
  const evidence = `${c} ${constraints.filter((x) => typeof x === "string").join(" ")}`;
  for (const rule of GENERIC_RULES) {
    if (!rule.generic.test(c)) continue;
    if (rule.specific.test(evidence)) return null;
    return { id: "narrow", question: rule.question, options: rule.options, category: c };
  }
  return null;
}

/**
 * Fold a narrowing answer back onto its category. Prefix mode keeps the
 * generic term so everything keyed off it (durations, bands, the search
 * query) still matches — "Italian restaurant" is still a restaurant.
 * Replace mode is for answers that ARE a complete venue type ("cocktail
 * bar", "arcade"). Chosen over routing answers through `constraints`
 * because constraints are HARD requirements enforced with unmet-constraint
 * refusals — a cuisine preference must narrow the search, not arm a
 * refusal when no venue description happens to evidence it.
 */
export function applyNarrowAnswer(category: string, answer: string): string {
  const a = (answer ?? "").trim();
  if (!a) return category;
  const rule = GENERIC_RULES.find((r) => r.generic.test(category ?? ""));
  if (!rule) return category;
  return rule.mode === "prefix" ? `${a} ${category}` : a;
}

const unspecified = (v: unknown): boolean =>
  typeof v !== "string" || !v.trim() || /^unspecified$/i.test(v.trim());

/** The "what kind of thing?" question — asked for ultra-vague prompts,
 *  and re-shown by the time-gate's "something else" action (batch 4b) so
 *  a blocked direction can be swapped without retyping the prompt. */
export function kindQuestion(): ClarifyQuestion {
  return {
    id: "kind",
    question: "What kind of thing?",
    options: ["food", "drinks", "something to do", "outdoors"],
  };
}

/**
 * Rules:
 *  - NO category at all ("not sure what to do") → ask what KIND of thing
 *    first; it's the highest-value answer, and without it the plan rests
 *    entirely on the broad general pool
 *  - no time signal at all → ask "When?"
 *  - a GENERIC category ("restaurant", bare "bar") → ask its narrowing
 *    question, even when a time/aesthetic is present — category presence
 *    is not category specificity, and "restaurant tonight" is not enough
 *    to search well. Narrowing WHAT outranks narrowing HOW (vibe).
 *  - aesthetic AND group AND constraints all unspecified → ask for a vibe
 *  - SKIP entirely when the prompt already gave enough: at least one real
 *    category AND (a time OR an aesthetic) — don't nag. A generic-category
 *    hit is the ONE exception to that skip, and it is deliberately narrow:
 *    the skip condition itself is unchanged for every specific category.
 */
export function clarifyQuestions(parsed: ParsedPrompt): ClarifyQuestion[] {
  const hasCategory = (parsed.category_signals ?? []).some(
    (c) => typeof c === "string" && c.trim() !== ""
  );
  const hasTime = !unspecified(parsed.time_window);
  const hasAesthetic = !unspecified(parsed.aesthetic);
  const hasGroup = !unspecified(parsed.group_context);
  const hasConstraints = (parsed.constraints ?? []).some(
    (c) => typeof c === "string" && c.trim() !== ""
  );

  // one narrowing question per DISTINCT generic category ("drinks then
  // another bar" is two slots but one question — the answer applies to both)
  const narrowQuestions: ClarifyQuestion[] = [];
  const seen = new Set<string>();
  for (const c of parsed.category_signals ?? []) {
    if (typeof c !== "string" || seen.has(c.trim())) continue;
    seen.add(c.trim());
    const q = genericCategoryQuestion(c, parsed.constraints ?? []);
    if (q) narrowQuestions.push(q);
  }

  if (hasCategory && (hasTime || hasAesthetic) && narrowQuestions.length === 0) return [];

  const questions: ClarifyQuestion[] = [];
  // An ultra-vague prompt gives the pipeline nothing to aim at. One cheap
  // question ("what kind of thing?") narrows it from "everything open in
  // the city" to a real intent — deliberately 4 broad buckets, not an
  // exhaustive taxonomy: enough for a good guess, still one tap.
  if (!hasCategory) {
    questions.push(kindQuestion());
  }
  // generic-category narrowing next: it shares the same 3-question budget
  // and sits ABOVE when/vibe — a concrete WHAT beats both
  questions.push(...narrowQuestions);
  if (!hasTime) {
    questions.push({
      id: "when",
      question: "When?",
      options: ["now", "later today", "pick a time"],
    });
  }
  if (!hasAesthetic && !hasGroup && !hasConstraints) {
    questions.push({
      id: "vibe",
      question: "What kind of vibe are you going for?",
      options: ["cozy", "lively", "quiet"],
    });
  }
  return questions.slice(0, 3);
}

/**
 * Map a "What kind of thing?" answer onto category_signals. The buckets
 * map to terms the rest of the pipeline already understands (bands,
 * durations, search): "drinks"→bar, "outdoors"→park. "Something to do"
 * stays deliberately EMPTY — that's the general pool, which is exactly
 * the right tool for "surprise me"; free text passes through as its own
 * category so "bowling" works like any typed prompt.
 */
export function categoriesForKindAnswer(answer: string): string[] {
  const a = answer.trim().toLowerCase();
  if (!a) return [];
  if (a === "food") return ["restaurant"];
  if (a === "drinks") return ["bar"];
  if (a === "outdoors") return ["park"];
  if (a === "something to do") return [];
  return [answer.trim()];
}

/** Map a "When?" answer onto a time_window the resolver understands. */
export function timeWindowForWhenAnswer(answer: string): string {
  const a = answer.trim().toLowerCase();
  if (a === "now") return "now"; // resolver: next full hour (immediate)
  if (a === "later today") return "evening"; // existing day-part; rolls forward
  return answer.trim(); // free text ("7pm", "tomorrow morning") passes through
}
