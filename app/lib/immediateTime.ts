// Deterministic floor for IMMEDIATE-time language, in the same spirit as
// the swap engine's parseTimeExpr: arithmetic-adjacent time language is
// never trusted to the LLM alone. Live repro (2026-07-24): the parse
// returned time_window "unspecified" for "restaurants to eat at right
// now" — the immediacy was lost entirely, so the resolver fell to the
// restaurant default (19:00), which at 11:28 PM had passed and rolled the
// whole plan to TOMORROW. The parse prompt now teaches the model to map
// this phrasing to "now"; this floor guarantees the common phrases
// regardless of what the model returns.
//
// The line drawn: strong, unambiguous immediacy phrases only. Bare "now"
// is deliberately NOT matched on the raw prompt ("now that I think about
// it…") — but "right now" / "open now" / "ASAP" cannot mean anything
// else in a day-planner prompt. The model instruction covers the long
// tail this regex can't ("as soon as we can head out").
export const IMMEDIATE_PATTERN =
  /\b(right now|right away|asap|a\.s\.a\.p\.?|as soon as possible|immediately|at this (?:very )?moment|this instant|open now)\b/i;

/** Does the RAW prompt text state immediacy? */
export function hasImmediateTimeSignal(prompt: string): boolean {
  return IMMEDIATE_PATTERN.test(prompt ?? "");
}
