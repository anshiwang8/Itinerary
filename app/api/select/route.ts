import { NextRequest, NextResponse } from "next/server";
import { ParsedPrompt, Place } from "../places/search/filter";

// LLM candidate selection: one Groq call over ALL filtered pools picks
// exactly one venue per category, judged on fit + cohesion across the
// set. Final piece of the single-slot pipeline.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are the venue selector for a day-plan generator. You receive the user's parsed request and candidate venue pools grouped by category. Pick exactly ONE venue per category.

Rules:
- Select by "id", ONLY from the provided candidates within that same category. Never invent an id and never borrow one from another category.
- Judge fit against the parsed request (aesthetic, group_context, budget, constraints) AND cohesion across the full set: the chosen venues should make sense together as one outing — compatible vibe, and reasonable proximity to each other (use the lat/lng provided).
- Prefer a coherent outing over individually highest-rated venues.
- "reason": exactly one sentence in a user-facing tone, e.g. "Cozy and low-key, a natural fit for a quiet date." Never meta commentary about ids, JSON, data, or your selection process.

Respond with ONLY a single JSON object, no prose, no markdown fences:
{ "selections": [ { "category": string, "id": string, "reason": string } ] }
Exactly one entry per category, in the order the categories were given.`;

interface Selection {
  category: string;
  id: string | null;
  reason: string;
  fallback?: boolean;
  name?: string;
  rating?: number;
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

export async function POST(request: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GROQ_API_KEY is not set." }, { status: 500 });
  }

  let parsed: ParsedPrompt;
  let poolsIn: Record<string, Place[]>;
  try {
    const body = await request.json();
    parsed = body?.parsed;
    poolsIn = body?.pools;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || !poolsIn || typeof poolsIn !== "object") {
    return NextResponse.json(
      { error: "`parsed` and `pools` are required in the body." },
      { status: 400 }
    );
  }

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

  if (Object.keys(pools).length === 0) {
    return NextResponse.json({ selections: emptySelections });
  }

  const candidates: Record<string, unknown[]> = {};
  for (const [category, places] of Object.entries(pools)) {
    candidates[category] = places.map(candidateView);
  }

  const userMessage = JSON.stringify({ request: parsed, candidates });
  const messages: unknown[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  let raw = "";
  let selections: Selection[] | null = null;
  try {
    raw = await callGroq(apiKey, messages);
    let parsedOut: { selections?: Selection[] };
    try {
      parsedOut = JSON.parse(raw);
    } catch (err) {
      return NextResponse.json(
        {
          error: "Failed to parse Groq selection response as JSON.",
          details: err instanceof Error ? err.message : String(err),
          raw,
        },
        { status: 500 }
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
        return NextResponse.json(
          {
            error: "Failed to parse Groq retry response as JSON.",
            details: err instanceof Error ? err.message : String(err),
            raw,
          },
          { status: 500 }
        );
      }
      problems = findProblems(parsedOut.selections, pools);
    }

    // Assemble final selections in pool order; per-category fallback to
    // highest-rated for anything still invalid after the retry.
    const byCategory = new Map<string, Selection>();
    if (Array.isArray(parsedOut.selections)) {
      for (const s of parsedOut.selections) {
        if (s && typeof s.category === "string") byCategory.set(s.category, s);
      }
    }
    selections = Object.entries(pools).map(([category, places]) => {
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
  } catch (err) {
    return NextResponse.json(
      {
        error: "Selection failed.",
        details: err instanceof Error ? err.message : String(err),
        raw,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ selections: [...selections, ...emptySelections] });
}
