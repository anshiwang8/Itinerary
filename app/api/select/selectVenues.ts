// LLM candidate selection core, shared by the /api/select route and the
// reroute engine. One Groq call over all pools, validation ladder:
// invalid ids → one correction retry → highest-rated fallback.
import { ParsedPrompt, Place } from "../places/search/filter";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are the venue selector for a day-plan generator. You receive the user's parsed request and candidate venue pools grouped by category. Pick exactly ONE venue per category.

Rules:
- Select by "id", ONLY from the provided candidates within that same category. Never invent an id and never borrow one from another category.
- Judge fit against the parsed request (aesthetic, group_context, budget, constraints) AND cohesion across the full set: the chosen venues should make sense together as one outing — compatible vibe, and reasonable proximity to each other (use the lat/lng provided).
- Prefer a coherent outing over individually highest-rated venues.
- BUDGET (applies whenever request.budget is stated): strongly prefer venues whose "price" is known and fits the budget (for cheap/budget requests: PRICE_LEVEL_INEXPENSIVE or PRICE_LEVEL_MODERATE). A venue with price null/unknown is a RISK, not a free pass — pick it only when no appropriately-priced option exists in that category. Also use your own general knowledge as a tiebreaker: if you recognize a venue as upscale or pricey even though its price data is missing, avoid it. When affordability influenced a pick, say so in the reason.
- "reason": exactly one sentence in a user-facing tone, e.g. "Cozy and low-key, a natural fit for a quiet date." Never meta commentary about ids, JSON, data, or your selection process.

Respond with ONLY a single JSON object, no prose, no markdown fences:
{ "selections": [ { "category": string, "id": string, "reason": string } ] }
Exactly one entry per category, in the order the categories were given.`;

export interface Selection {
  category: string;
  id: string | null;
  reason: string;
  fallback?: boolean;
  name?: string;
  rating?: number;
}

/** Groq output unparseable as JSON — carries the raw text for debugging. */
export class SelectParseError extends Error {
  raw: string;
  constructor(message: string, raw: string, cause?: unknown) {
    super(message);
    this.raw = raw;
    this.name = "SelectParseError";
    if (cause instanceof Error) this.message += ` (${cause.message})`;
  }
}

// Compact candidate view sent to the model — just what's needed to
// judge fit and proximity, keeps tokens down.
function candidateView(p: Place) {
  return {
    id: p.id,
    name: p.displayName?.text ?? "(unnamed)",
    rating: p.rating ?? null,
    price: p.priceLevel ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
  };
}

async function callGroq(apiKey: string, messages: unknown[]) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      response_format: { type: "json_object" },
      temperature: 0,
    }),
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `Groq request failed (${res.status}).`);
  }
  return data?.choices?.[0]?.message?.content ?? "";
}

// Check the model's selections against the pools. Returns a list of
// human-readable problems (empty = valid).
function findProblems(
  selections: unknown,
  pools: Record<string, Place[]>
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(selections)) {
    return ["`selections` is missing or not an array"];
  }
  const byCategory = new Map<string, { id?: unknown }>();
  for (const s of selections as { category?: string; id?: unknown }[]) {
    if (s && typeof s.category === "string") byCategory.set(s.category, s);
  }
  for (const [category, places] of Object.entries(pools)) {
    const sel = byCategory.get(category);
    if (!sel) {
      problems.push(`no selection for category "${category}"`);
      continue;
    }
    const validIds = new Set(places.map((p) => p.id));
    if (typeof sel.id !== "string" || !validIds.has(sel.id)) {
      problems.push(
        `selected id "${String(sel.id)}" is not in the "${category}" pool`
      );
    }
  }
  return problems;
}

function highestRated(places: Place[]): Place {
  return [...places].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))[0];
}

/**
 * Select one venue per category. Empty pools resolve to null-id
 * selections without touching the LLM; invalid model answers get one
 * correction retry, then a highest-rated fallback flagged on the
 * selection. Throws SelectParseError when Groq output isn't JSON.
 */
export async function selectVenues(
  apiKey: string,
  parsed: ParsedPrompt,
  poolsIn: Record<string, Place[]>
): Promise<Selection[]> {
  // Ignore meta keys (e.g. _dropLog passed through by mistake) and
  // split empty pools out — they're answered without the LLM.
  const pools: Record<string, Place[]> = {};
  const emptyCategories: string[] = [];
  for (const [k, v] of Object.entries(poolsIn)) {
    if (k.startsWith("_") || !Array.isArray(v)) continue;
    if (v.length === 0) emptyCategories.push(k);
    else pools[k] = v;
  }

  const emptySelections: Selection[] = emptyCategories.map((category) => ({
    category,
    id: null,
    reason: "no venues survived filtering",
  }));

  if (Object.keys(pools).length === 0) return emptySelections;

  const candidates: Record<string, unknown[]> = {};
  for (const [category, places] of Object.entries(pools)) {
    candidates[category] = places.map(candidateView);
  }

  const messages: unknown[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ request: parsed, candidates }) },
  ];

  let raw = await callGroq(apiKey, messages);
  let parsedOut: { selections?: Selection[] };
  try {
    parsedOut = JSON.parse(raw);
  } catch (err) {
    throw new SelectParseError(
      "Failed to parse Groq selection response as JSON.",
      raw,
      err
    );
  }

  let problems = findProblems(parsedOut.selections, pools);
  if (problems.length > 0) {
    // One correction retry with the problems spelled out.
    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content: `Your previous answer was invalid: ${problems.join("; ")}. Respond again with ONLY the JSON object, selecting ids strictly from the provided candidates for each category.`,
    });
    raw = await callGroq(apiKey, messages);
    try {
      parsedOut = JSON.parse(raw);
    } catch (err) {
      throw new SelectParseError(
        "Failed to parse Groq retry response as JSON.",
        raw,
        err
      );
    }
  }

  // Assemble final selections in pool order; per-category fallback to
  // highest-rated for anything still invalid after the retry.
  const byCategory = new Map<string, Selection>();
  if (Array.isArray(parsedOut.selections)) {
    for (const s of parsedOut.selections) {
      if (s && typeof s.category === "string") byCategory.set(s.category, s);
    }
  }
  const selections = Object.entries(pools).map(([category, places]) => {
    const validIds = new Set(places.map((p) => p.id));
    const sel = byCategory.get(category);
    if (sel && typeof sel.id === "string" && validIds.has(sel.id)) {
      const place = places.find((p) => p.id === sel.id)!;
      return {
        category,
        id: sel.id,
        reason: typeof sel.reason === "string" ? sel.reason : "",
        name: place.displayName?.text,
        rating: place.rating,
      };
    }
    const fb = highestRated(places);
    return {
      category,
      id: fb.id,
      reason: "Top-rated option in this category.",
      fallback: true,
      name: fb.displayName?.text,
      rating: fb.rating,
    };
  });

  return [...selections, ...emptySelections];
}
