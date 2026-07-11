// The fail-loud surface for bad input — pure, deterministic checks that
// route every degenerate/impossible/contradictory prompt to ONE honest
// message (clear reason + suggested fix) instead of an empty map or a
// wrong error. Each guard returns a user-facing string, or null to let
// the pipeline continue. Runs client-side before/around the API calls,
// same pattern as resolveStartTimeChecked.
import { ParsedPrompt } from "../api/places/search/filter";

export const UNPARSEABLE_MESSAGE =
  "I couldn't make sense of that — try describing your evening, like “dinner and drinks in Ossington”.";

export const CONTRADICTION_MESSAGE =
  "That's a bit contradictory — cheap and fancy pull opposite ways. Which matters more?";

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

/**
 * Contradiction guard: a budget pulling one way and an aesthetic pulling
 * the other ("cheap fancy dinner") can't both be satisfied — say so
 * instead of returning an empty, silently price-filtered map.
 */
export function contradictionReason(
  prompt: string,
  parsed: ParsedPrompt | null
): string | null {
  const fields = [parsed?.budget ?? "", parsed?.aesthetic ?? "", (parsed?.constraints ?? []).join(" ")]
    .join(" ");
  const haystack = `${prompt} ${fields}`.replace(NEGATED_FANCY, "");
  if (CHEAP_SIGNAL.test(haystack) && FANCY_SIGNAL.test(haystack)) {
    return CONTRADICTION_MESSAGE;
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
