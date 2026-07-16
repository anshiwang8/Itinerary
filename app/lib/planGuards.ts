// The fail-loud surface for bad input — pure, deterministic checks that
// route every degenerate/impossible/contradictory prompt to ONE honest
// message (clear reason + suggested fix) instead of an empty map or a
// wrong error. Each guard returns a user-facing string, or null to let
// the pipeline continue. Runs client-side before/around the API calls,
// same pattern as resolveStartTimeChecked.
import { ParsedPrompt, DropEntry } from "../api/places/search/filter";
import type { Selection } from "../api/select/selectVenues";

export const UNPARSEABLE_MESSAGE =
  "I couldn't make sense of that — try describing your evening, like “dinner and drinks in Ossington”.";

export const CONTRADICTION_MESSAGE =
  "That's a bit contradictory — cheap and fancy pull opposite ways.";

// keyboard rows for the mash check ("asdfghjkl" is literally the home row)
const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

/**
 * Pre-parse guard: prompts with no real words never reach the LLM.
 * Catches "." / "!!!" / "123" (fewer than 3 letters) and keyboard mash
 * ("asdfghjkl") where every 4+ letter word is a contiguous row run.
 */
export function degeneratePromptReason(prompt: string): string | null {
  const letters = (prompt.match(/\p{L}/gu) ?? []).length;
  if (letters < 3) return UNPARSEABLE_MESSAGE;

  const words = prompt.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (
    words.length > 0 &&
    words.every((w) => w.length >= 4 && KEY_ROWS.some((row) => row.includes(w)))
  ) {
    return UNPARSEABLE_MESSAGE;
  }
  return null;
}

/** The all-unspecified parse signature: the model extracted nothing. */
export function isEmptyParse(parsed: ParsedPrompt): boolean {
  const unspecified = (v: unknown) =>
    typeof v !== "string" || !v.trim() || /^unspecified$/i.test(v.trim());
  const noCategories = !(parsed.category_signals ?? []).some(
    (c) => typeof c === "string" && c.trim() !== ""
  );
  return (
    noCategories &&
    unspecified(parsed.time_window) &&
    unspecified(parsed.aesthetic) &&
    unspecified(parsed.group_context) &&
    (parsed.budget == null || !String(parsed.budget).trim()) &&
    !(parsed.constraints ?? []).some((c) => typeof c === "string" && c.trim() !== "")
  );
}

/**
 * Post-parse guard. An empty parse ALONE is not gibberish — "not sure
 * what to do" is real words and genuine uncertainty, and it deserves the
 * general "things to do" itinerary, not a rejection. Only fail when the
 * PROMPT itself is degenerate by the same standard as the pre-parse
 * check; a sincere-but-vague prompt returns null and falls through to
 * the general pool.
 */
export function emptyParseReason(parsed: ParsedPrompt, prompt: string): string | null {
  if (!isEmptyParse(parsed)) return null;
  return degeneratePromptReason(prompt);
}

const CHEAP_SIGNAL =
  /\b(cheap|cheaply|budget|inexpensive|affordable|dirt[- ]cheap|broke|student budget)\b/i;
const FANCY_SIGNAL =
  /\b(fancy|upscale|fine[- ]dining|luxur\w*|high[- ]end|swanky|posh|elegant|michelin|extravagant|splurge)\b/i;
// "nothing fancy" / "not too posh" is a cheap signal, not a fancy one
const NEGATED_FANCY =
  /\b(?:nothing|not|no|isn'?t|without)\s+(?:too\s+|very\s+)?(?:fancy|upscale|posh|elegant|swanky|high[- ]end)\b/gi;

// A hard dietary requirement pulling against a venue whose whole identity is
// the thing it forbids ("vegan steakhouse"). Same shape as the cheap/fancy
// pair, but PER dietary term — the incompatibility depends on the diet
// (a "gluten-free steakhouse" is fine; a "halal steakhouse" is fine — halal
// steak exists). Deliberately NOT exhaustive: just the common/obvious cases.
const DIETARY_VENUE_CONFLICTS: Array<[RegExp, RegExp]> = [
  // plant-based diets vs meat-/seafood-defined venues
  [
    /\b(vegan|vegetarian|plant[- ]based)\b/i,
    /\b(steak\s?house|steakhouse|chop\s?house|chophouse|butcher|bbq|barbe?cue|barbeque|churrascaria|smoke\s?house|smokehouse|rib\s?(?:house|joint|shack)|meatery|seafood|oyster\s?bar|raw\s?bar|fish\s?house)\b/i,
  ],
  // pork-/shellfish-forbidding diets vs pork-/shellfish-defined venues
  // (BBQ deliberately excluded here — halal/kosher BBQ is common)
  [
    /\b(halal|kosher)\b/i,
    /\b(pork|hog\b|bacon|pig\s?roast|oyster\s?bar|raw\s?bar|shellfish|lobster\s?(?:shack|house)?|crab\s?shack|clam\s?bar)\b/i,
  ],
];

// Accommodation phrasing — the diet is a preference for the GROUP, not a hard
// requirement for the venue: "vegan options", "vegan-friendly", "a vegan
// friend", "vegetarian menu". Stripped before the dietary-conflict check so
// "vegan options at a steakhouse" / "steakhouse with a vegan friend" don't
// trip it. Whole-venue asks ("vegan steakhouse") carry no such qualifier.
const DIETARY_ACCOMMODATION =
  /\b(?:vegan|vegetarian|plant[- ]based|halal|kosher|gluten[- ]free)[\s-]+(?:options?|friendly|friend|choices?|dishes?|menu|alternatives?|selections?)\b/gi;

/**
 * Contradiction guard: two stated wants that can't both hold — say so
 * instead of returning an empty, silently filtered map. Covers a budget vs
 * aesthetic clash ("cheap fancy dinner") and a hard dietary requirement vs
 * an incompatible venue type ("vegan steakhouse"), naming the actual pair.
 */
export function contradictionReason(
  prompt: string,
  parsed: ParsedPrompt | null
): string | null {
  const fields = [
    parsed?.budget ?? "",
    parsed?.aesthetic ?? "",
    (parsed?.constraints ?? []).join(" "),
    (parsed?.category_signals ?? []).join(" "),
  ].join(" ");
  const raw = `${prompt} ${fields}`;

  // cheap vs fancy
  const cf = raw.replace(NEGATED_FANCY, "");
  if (CHEAP_SIGNAL.test(cf) && FANCY_SIGNAL.test(cf)) {
    return CONTRADICTION_MESSAGE;
  }

  // dietary vs incompatible venue type — the venue word is matched on the
  // raw text; the dietary word is matched with accommodation phrasing removed
  const dietText = raw.replace(DIETARY_ACCOMMODATION, " ");
  for (const [diet, venue] of DIETARY_VENUE_CONFLICTS) {
    const d = dietText.match(diet);
    const v = raw.match(venue);
    if (d && v) {
      return `That's a bit contradictory — ${d[0].toLowerCase()} and ${v[0].toLowerCase()} pull opposite ways.`;
    }
  }

  return null;
}

/** Every pool came back empty (post-filter) — the honest "nothing survived". */
export function noVenuesReason(categories: string[], whenLabel: string | null): string {
  const cats = categories.filter((c) => c && c !== "general");
  const what = cats.length > 0 ? `${cats.join(" or ")} spots` : "places";
  const when = whenLabel ? ` open around ${whenLabel}` : "";
  return `Couldn't find any ${what}${when} — everything nearby got filtered out. Try a different time?`;
}

/** Every category was weather-blocked — name the weather, suggest indoors. */
export function weatherBlockedReason(
  blocks: Array<{ category: string; reason: string }>
): string {
  const detail = blocks.map((b) => `${b.category}: ${b.reason}`).join("; ");
  return `Couldn't plan this one — ${detail}. Try an indoor plan?`;
}

/** A hard constraint no candidate actually meets — fail loud, never hedge. */
export function unmetConstraintReason(category: string, constraint: string): string {
  return `Couldn't find a ${category} that's really ${constraint} — want to drop a constraint, or try a different kind of place?`;
}

// ── partial-failure recovery ──────────────────────────────────────────
// SOME categories returned real picks but ≥1 came back with an empty pool
// (e.g. "ramen then a bar" where the only nearby ramen was permanently
// closed). We never silently drop the empty one — name the honest reason
// (from the objective drop log) and let the caller offer to recover.
// Distinct from the ALL-empty case, which keeps its own noVenuesReason
// path and must never route through here.

/** An empty-pool selection: id null with NO unmet constraint (a constraint
 *  failure is a different, harder case handled by unmetConstraintReason). */
function isEmptyPoolPick(s: Selection): boolean {
  return s.id === null && !s.unmetConstraint;
}

/**
 * The categories that came back empty in a PARTIAL failure — at least one
 * real pick exists alongside ≥1 empty pool. Returns [] when nothing is
 * empty OR when EVERYTHING is empty (all-empty stays on noVenuesReason).
 */
export function partialEmptyCategories(selections: Selection[]): string[] {
  const empties = selections.filter(isEmptyPoolPick);
  const hasRealPick = selections.some((s) => s.id !== null);
  if (empties.length === 0 || !hasRealPick) return [];
  return empties.map((s) => s.category);
}

const meaningfulLocation = (label?: string | null): string | null =>
  label && label.trim() && label.trim().toLowerCase() !== "unspecified" ? label.trim() : null;

// Friendly phrasing for the dominant objective drop rule that emptied a
// category's pool. null when nothing was even returned nearby (no drops).
function reasonFromDrops(category: string, drops: DropEntry[]): string | null {
  const mine = drops.filter((d) => d.category === category);
  if (mine.length === 0) return null;
  const counts = new Map<DropEntry["rule"], number>();
  for (const d of mine) counts.set(d.rule, (counts.get(d.rule) ?? 0) + 1);
  const [rule] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const one = mine.length === 1;
  switch (rule) {
    case "businessStatus":
      return one ? "the only one nearby is permanently closed" : "the ones nearby are permanently closed";
    case "hours":
      return one ? "the only one nearby is closed at that hour" : "the ones nearby are closed at that hour";
    case "rating":
      return one ? "the only one nearby is too poorly rated" : "the ones nearby are too poorly rated";
    case "price":
      return one ? "the only one nearby doesn't fit your budget" : "the ones nearby don't fit your budget";
    case "dedup":
      return "the only match is already elsewhere in your plan";
    default:
      return null;
  }
}

/**
 * Honest, fail-loud-voice sentence for ONE empty category, using whatever
 * objective drop data explains it (permanently closed, closed then, low
 * rating, over budget). Same tone as noVenuesReason / unmetConstraintReason.
 */
export function emptyCategoryReason(
  category: string,
  drops: DropEntry[],
  locationLabel?: string | null
): string {
  const loc = meaningfulLocation(locationLabel);
  const where = loc ? ` near ${loc}` : " nearby";
  const why = reasonFromDrops(category, drops);
  return why
    ? `Couldn't find any ${category} open${where} — ${why}.`
    : `Couldn't find any ${category}${where}.`;
}

/** The widen-offer label, scoped to the plan's neighborhood/location. */
export function widenOfferLabel(locationLabel?: string | null): string {
  const loc = meaningfulLocation(locationLabel);
  return loc ? `Look further than ${loc}` : "Look further out";
}

/**
 * Order resolved selections back into the ORIGINAL request order
 * (parsed.category_signals). selectVenues appends empty-pool categories
 * last and the recovery flow resolves them in that appended position — so
 * without this, a recovered FIRST-requested category ("ramen then a bar")
 * renders at the END of the plan. `slots` maps a replacement category to
 * the requested category whose slot it fills (recovery's follow-up path,
 * e.g. { dessert: "ramen" }). Categories not in the request (e.g.
 * "general") sort after the known ones, keeping their relative order.
 */
export function orderByRequest(
  selections: Selection[],
  categorySignals: string[] | undefined | null,
  slots?: Record<string, string>
): Selection[] {
  const signals = (categorySignals ?? []).filter(
    (c): c is string => typeof c === "string" && c.trim() !== ""
  );
  if (signals.length === 0) return selections;
  const pos = (s: Selection) => {
    const slot = slots?.[s.category] ?? s.category;
    const i = signals.indexOf(slot);
    return i === -1 ? signals.length : i;
  };
  // Array.prototype.sort is stable — ties keep their existing order
  return [...selections].sort((a, b) => pos(a) - pos(b));
}
