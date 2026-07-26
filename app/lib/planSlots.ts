import type { ParsedPrompt } from "../api/places/search/filter";

export const MAX_PLAN_STOPS = 8;

const COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};

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

type UnresolvedSlotResolution = Exclude<
  SlotResolution,
  { kind: "resolved" }
>;

export type FinalizedRequestedSlots =
  | { ok: true; parsed: ParsedPrompt }
  | {
      ok: false;
      resolution: UnresolvedSlotResolution;
      reason: string;
    };

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

/**
 * Final gate after clarification. A clarification may add a kind or an
 * explicit distribution, so resolve the slots again and only return a
 * pipeline-ready parse when every requested stop has a category.
 */
export function finalizeRequestedSlots(
  parsed: ParsedPrompt
): FinalizedRequestedSlots {
  const resolution = resolveRequestedSlots(parsed);
  if (resolution.kind === "resolved") {
    return {
      ok: true,
      parsed: { ...parsed, category_signals: resolution.slots },
    };
  }
  if (resolution.kind === "needs-kind") {
    return {
      ok: false,
      resolution,
      reason: `Choose what kind of thing you want for ${
        resolution.count === 1 ? "the stop" : `all ${resolution.count} stops`
      }.`,
    };
  }
  if (resolution.kind === "needs-distribution") {
    return {
      ok: false,
      resolution,
      reason: "Tell me how to split the requested stops so I don't guess.",
    };
  }
  return { ok: false, resolution, reason: resolution.reason };
}

function countFromToken(token: string | undefined): number | null {
  if (!token) return 1;
  if (/^\d+$/.test(token)) return Number(token);
  return COUNT_WORDS[token.toLowerCase()] ?? null;
}

function categoryFromText(text: string, categories: string[]): string | null {
  const normalized = text.trim().toLowerCase();
  const exact = categories.find((category) => category.toLowerCase() === normalized);
  if (exact) return exact;
  const contained = categories.filter((category) => {
    const c = category.toLowerCase();
    return normalized.includes(c) || c.includes(normalized);
  });
  return contained.length === 1 ? contained[0] : null;
}

/** Parse answers such as "2 dinner + 1 drinks" without asking the LLM. */
export function slotsFromDistributionAnswer(
  answer: string,
  categories: string[],
  stopCount: number
): string[] | null {
  if (!validStopCount(stopCount)) return null;
  const allowed = [...new Set(cleanCategories(categories))];
  if (allowed.length < 2) return null;
  const segments = answer
    .split(/\s*(?:\+|,|;|\band\b)\s*/i)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const slots: string[] = [];
  for (const segment of segments) {
    const match = segment.match(
      /^(?:(\d+|one|two|three|four|five|six|seven|eight)\s+)?(.+)$/i
    );
    if (!match) return null;
    const count = countFromToken(match[1]);
    const category = categoryFromText(match[2], allowed);
    if (!count || !category || slots.length + count > stopCount) return null;
    for (let i = 0; i < count; i++) slots.push(category);
  }
  return slots.length === stopCount ? slots : null;
}

export function distributionOptions(categories: string[], stopCount: number): string[] {
  const allowed = [...new Set(cleanCategories(categories))];
  if (!validStopCount(stopCount) || allowed.length < 2 || stopCount < allowed.length) {
    return [];
  }
  const remaining = stopCount - allowed.length;
  if (remaining === 0) {
    return [allowed.map((category) => `1 ${category}`).join(" + ")];
  }
  return allowed.slice(0, 4).map((favored) =>
    allowed
      .map((category) => `${1 + (category === favored ? remaining : 0)} ${category}`)
      .join(" + ")
  );
}
