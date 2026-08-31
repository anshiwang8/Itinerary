import type { ParsedPrompt } from "../api/places/search/filter";

export const MAX_PLAN_STOPS = 8;

function cleanCategories(categories: string[]): string[] {
  return categories
    .filter((category): category is string => typeof category === "string")
    .map((category) => category.trim())
    .filter(Boolean);
}

export function validStopCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_PLAN_STOPS
  );
}

export type SlotResolution =
  | { kind: "resolved"; slots: string[] }
  | { kind: "needs-kind"; count: number }
  | { kind: "needs-distribution"; count: number; categories: string[] }
  | { kind: "invalid"; reason: string };

/**
 * Apply stop_count without inventing a distribution. One category can be
 * repeated, and an already-complete list can be used as-is. Every other
 * mismatch needs a user decision.
 */
export function resolveRequestedSlots(parsed: ParsedPrompt): SlotResolution {
  const categories = cleanCategories(parsed.category_signals ?? []);
  const count = parsed.stop_count;
  if (count === null || count === undefined) {
    return { kind: "resolved", slots: categories };
  }
  if (!validStopCount(count)) {
    return {
      kind: "invalid",
      reason: `Choose between 1 and ${MAX_PLAN_STOPS} whole-number stops.`,
    };
  }
  if (categories.length === 0) return { kind: "needs-kind", count };
  if (categories.length === count) return { kind: "resolved", slots: categories };

  const distinct = [...new Set(categories.map((category) => category.toLowerCase()))];
  if (distinct.length === 1) {
    return {
      kind: "resolved",
      slots: Array.from({ length: count }, () => categories[0]),
    };
  }
  return { kind: "needs-distribution", count, categories: [...new Set(categories)] };
}

export function normalizeStopCountSlots(parsed: ParsedPrompt): ParsedPrompt {
  const resolution = resolveRequestedSlots(parsed);
  if (resolution.kind !== "resolved") return parsed;
  return { ...parsed, category_signals: resolution.slots };
}
