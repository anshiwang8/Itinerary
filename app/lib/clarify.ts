// Lightweight clarifying questions — pure, rule-based, NO LLM call (the
// LLM does semantic work; deciding whether to ask is a deterministic
// field check). Given a parse, return 0–3 targeted questions to show
// before search/select. No accounts, no profiles — deliberately deferred.
import { ParsedPrompt } from "../api/places/search/filter";

export interface ClarifyQuestion {
  id: "kind" | "when" | "vibe";
  question: string;
  /** quick-pick chips; the UI also allows free text */
  options: string[];
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
  // An ultra-vague prompt gives the pipeline nothing to aim at. One cheap
  // question ("what kind of thing?") narrows it from "everything open in
  // the city" to a real intent — deliberately 4 broad buckets, not an
  // exhaustive taxonomy: enough for a good guess, still one tap.
  if (!hasCategory) {
    questions.push(kindQuestion());
  }
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
