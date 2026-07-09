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
- CONSTRAINTS are hard requirements, not preferences. Treat a candidate as meeting a constraint (dietary, accessibility, etc.) ONLY when the provided data, its "desc", or the venue's name/known character is actual evidence for it — a "vegan" constraint needs a vegan or clearly plant-based venue, not a steakhouse that might have options. If NO candidate in a category meets every constraint, do NOT pick a best-effort venue: return { "category": <category>, "id": null, "unmet_constraint": <the constraint no candidate meets> } for that category instead. NEVER pick a venue while telling the user to verify — reasons must not contain hedges like "worth confirming", "check with the venue", or "may accommodate".
- "reason": exactly one sentence in a user-facing tone, e.g. "Cozy and low-key, a natural fit for a quiet date." Never meta commentary about ids, JSON, data, or your selection process.

Respond with ONLY a single JSON object, no prose, no markdown fences:
{ "selections": [ { "category": string, "id": string | null, "reason": string, "unmet_constraint": string | null } ] }
"id" may be null ONLY together with a non-null "unmet_constraint".
Exactly one entry per category, in the order the categories were given.`;

export interface Selection {
  category: string;
  id: string | null;
  reason: string;
  fallback?: boolean;
  name?: string;
  rating?: number;
  /** price + one-line description travel with the pick so the UI never
   * depends on a stale pools lookup after a swap/reroute */
  priceLevel?: string;
  description?: string;
  /** set (with id: null) when no candidate actually meets a hard
   * constraint — the caller fails loud instead of hedging */
  unmetConstraint?: string;
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
    // constraint evidence lives here ("plant-based", "patio", …)
    desc: p.editorialSummary?.text ?? null,
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

// Raw selection shape as the model returns it (unmet_constraint is the
// wire name; Selection carries it as unmetConstraint).
interface RawSelection {
  category?: string;
  id?: unknown;
  reason?: unknown;
  unmet_constraint?: unknown;
}

function unmetOf(sel: RawSelection | undefined): string | null {
  return sel && typeof sel.unmet_constraint === "string" && sel.unmet_constraint.trim()
    ? sel.unmet_constraint.trim()
    : null;
}

// Check the model's selections against the pools. Returns a list of
// human-readable problems (empty = valid). id: null is valid ONLY as an
// honest unmet-constraint answer.
function findProblems(
  selections: unknown,
  pools: Record<string, Place[]>
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(selections)) {
    return ["`selections` is missing or not an array"];
  }
  const byCategory = new Map<string, RawSelection>();
  for (const s of selections as RawSelection[]) {
    if (s && typeof s.category === "string") byCategory.set(s.category, s);
  }
  for (const [category, places] of Object.entries(pools)) {
    const sel = byCategory.get(category);
    if (!sel) {
      problems.push(`no selection for category "${category}"`);
      continue;
    }
    if (sel.id === null && unmetOf(sel)) continue; // honest constraint failure
    const validIds = new Set(places.map((p) => p.id));
    if (typeof sel.id !== "string" || !validIds.has(sel.id)) {
      problems.push(
        `selected id "${String(sel.id)}" is not in the "${category}" pool`
      );
    }
  }
  return problems;
}

// A pick whose reason tells the user to verify the constraint themselves
// is an unmet constraint in disguise — the code-side backstop for the
// no-hedging rule.
const HEDGE_PATTERN =
  /\b(worth confirming|check with|double[- ]?check|call ahead|ask (?:them|ahead|the venue)|may (?:be able to )?accommodate|might (?:be able to )?accommodate|verify|confirm (?:with|that|they))\b/i;

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
  const byCategory = new Map<string, Selection & RawSelection>();
  if (Array.isArray(parsedOut.selections)) {
    for (const s of parsedOut.selections) {
      if (s && typeof s.category === "string") byCategory.set(s.category, s);
    }
  }
  const hasConstraints = (parsed.constraints ?? []).some(
    (c) => typeof c === "string" && c.trim() !== ""
  );
  const selections = Object.entries(pools).map(([category, places]): Selection => {
    const validIds = new Set(places.map((p) => p.id));
    const sel = byCategory.get(category);
    const unmet = unmetOf(sel);
    if (sel && sel.id === null && unmet) {
      // honest constraint failure — surfaced, never papered over
      return {
        category,
        id: null,
        reason: `no ${category} candidate actually meets "${unmet}"`,
        unmetConstraint: unmet,
      };
    }
    if (sel && typeof sel.id === "string" && validIds.has(sel.id)) {
      const place = places.find((p) => p.id === sel.id)!;
      const reason = typeof sel.reason === "string" ? sel.reason : "";
      if (hasConstraints && HEDGE_PATTERN.test(reason)) {
        // "may accommodate / check with them" = the constraint isn't met
        const c = (parsed.constraints ?? []).find(
          (x) => typeof x === "string" && x.trim() !== ""
        )!;
        return {
          category,
          id: null,
          reason: `no ${category} candidate verifiably meets "${c}"`,
          unmetConstraint: c,
        };
      }
      return {
        category,
        id: sel.id,
        reason,
        name: place.displayName?.text,
        rating: place.rating,
        priceLevel: place.priceLevel,
        description: place.editorialSummary?.text,
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
      priceLevel: fb.priceLevel,
      description: fb.editorialSummary?.text,
    };
  });

  return [...selections, ...emptySelections];
}
