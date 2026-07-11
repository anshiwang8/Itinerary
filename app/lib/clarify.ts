// Lightweight clarifying questions — pure, rule-based, NO LLM call (the
// LLM does semantic work; deciding whether to ask is a deterministic
// field check). Given a parse, return 0–2 targeted questions to show
// before search/select. No accounts, no profiles — deliberately deferred.
import { ParsedPrompt } from "../api/places/search/filter";

export interface ClarifyQuestion {
  id: "when" | "vibe";
  question: string;
  /** quick-pick chips; the UI also allows free text */
  options: string[];
}

const unspecified = (v: unknown): boolean =>
  typeof v !== "string" || !v.trim() || /^unspecified$/i.test(v.trim());

/**
 * Rules:
 *  - no time signal at all → ask "When?"
 *  - aesthetic AND group AND constraints all unspecified → ask for a vibe
 *  - SKIP entirely when the prompt already gave enough: at least one real
 *    category AND (a time OR an aesthetic) — don't nag.
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

  if (hasCategory && (hasTime || hasAesthetic)) return [];

  const questions: ClarifyQuestion[] = [];
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
  return questions.slice(0, 2);
}

/** Map a "When?" answer onto a time_window the resolver understands. */
export function timeWindowForWhenAnswer(answer: string): string {
  const a = answer.trim().toLowerCase();
  if (a === "now") return "now"; // resolver: next full hour (immediate)
  if (a === "later today") return "evening"; // existing day-part; rolls forward
  return answer.trim(); // free text ("7pm", "tomorrow morning") passes through
}
