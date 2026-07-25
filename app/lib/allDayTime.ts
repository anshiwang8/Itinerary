// Deterministic floor for ALL-DAY duration language — the sibling of
// immediateTime.ts, same contract: time language is never trusted to the
// LLM alone. Live probe (2026-07-24): the parse prompt teaches the model
// that "a full schedule"/"a full day" is duration info captured as
// "all day", and it complies for the direct phrasings — but "immerse
// myself in japanese culture for a day" still came back "unspecified"
// (the model reads "for a day" as part of the immersion phrase). A
// missed all-day signal degrades to the earliest food-facet's category
// default — a 7 PM start for a DAY plan, with museum facets arriving
// after close. Wrong tone, cascading emptiness: floor it.
//
// The line drawn, as with the immediacy floor: strong phrases only.
// "all day", "a full/whole/entire day (or schedule)", "for a/the day".
// Bare "day"/"daytime" is NOT matched — "day trip ideas some other day"
// must not anchor at 11 AM.
export const ALL_DAY_PATTERN =
  /\b(all[- ]day|(?:a|the|my|your|our) (?:full|whole|entire) (?:day|schedule)|full schedule|for (?:a|the) day)\b/i;

/** Does the RAW prompt text ask for a full day? */
export function hasAllDaySignal(prompt: string): boolean {
  return ALL_DAY_PATTERN.test(prompt ?? "");
}
