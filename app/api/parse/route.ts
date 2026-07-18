import { NextRequest, NextResponse } from "next/server";
import { isMockMode, mockParse } from "../_mock/fixtures";
import type { ParsedPrompt } from "../places/search/filter";
import { UNPARSEABLE_MESSAGE } from "../../lib/planGuards";

// Standalone LLM parse step: natural-language prompt → structured plan
// parameters. Not connected to Places yet — this route only proves Groq
// returns clean, schema-matching JSON.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are a parser for a day-plan generator. Convert the user's request into JSON.

Respond with ONLY a single JSON object. No prose, no explanations, no markdown fences, no leading or trailing text. The object must match this exact schema — every key present, no extra keys:

{
  "time_window": string,        // ONLY timing and duration, nothing else. Capture the MOST SPECIFIC time information given: if an exact time is stated (e.g. "7pm", "around 3:30"), include it verbatim alongside any duration, e.g. "7pm, 2 hours". Preserve day qualifiers verbatim too ("today", "tomorrow", "Saturday"): e.g. "coffee at 6am tomorrow" → "tomorrow, 6am". Only fall back to a general day-part (morning/afternoon/evening/night) when no specific time is stated. "unspecified" if no time information at all
  "stop_count": number | null,  // ONLY if the user states a NUMBER of stops/places in words or digits (e.g. "3 stops", "exactly two places"); otherwise null. Never count listed activities yourself: "dinner then a bar" has no stated number, so stop_count is null (the activities still go in category_signals). Numbers that describe duration, clock times, people, or budget are NOT stop counts.
  "aesthetic": string,          // the vibe/mood the user wants, e.g. "cozy", "lively night out", "quiet and scenic"
  "category_signals": string[], // place/activity categories implied, e.g. ["coffee shop", "bookstore", "park"]. Capture EVERY distinct activity in the prompt, one entry each, including non-venue activities: "a walk" → "walk", "shopping" → "shopping", "a stroll in the park" → "park walk". Never merge or drop an activity because it isn't a business type. Preserve specific cuisine/food types as the category — "ramen" stays "ramen", "tacos" stays "tacos", never generalized to "restaurant". A VENUE FEATURE attached to an activity is NOT its own category: "dessert with a patio", "a bar with live music", "dinner with a view", "somewhere with outdoor seating" are each ONE activity — the feature ("patio", "live music", "a view", "outdoor seating", "rooftop") goes in "constraints", exactly like dietary words do. Only a genuinely distinct activity gets its own entry: "dinner then a bar" is two. PASSIVE OUTDOOR/NATURE ENJOYMENT normalizes to the category "park": sitting on a bench, quiet scenery, greenery, fresh air, people-watching outside, "somewhere calm outside", enjoying nature — all of these are "park", never a cafe/bar/restaurant with a view
  "group_context": string,      // who is going, e.g. "solo", "date", "family with kids", "group of friends"; "unspecified" if unknown
  "budget": string | null,      // budget signal if stated, e.g. "cheap", "under $50", "$$$"; null if unstated
  "constraints": string[],      // hard requirements — dietary/accessibility AND venue-feature modifiers attached to a category, e.g. ["wheelchair accessible", "vegetarian options", "patio", "live music", "indoors only"]; [] if none
  "location": string            // a neighbourhood/area WITHIN the city, only if the prompt states one ("west end", "downtown", "near the harbour"); "" if none. NEVER a city name — the city is supplied separately by the app, never inferred from the prompt
}`;

// The model returns JSON, but not necessarily the RIGHT JSON. A missing
// `location` used to sail through here and get rejected two routes later
// by a body-shape check, whose developer-facing message ("`parsed` (the
// /api/parse output object) is required in the body.") went straight to
// the user — precisely what planGuards exists to prevent. Coercing every
// field to its documented empty value turns a shape miss into a
// vague-but-plannable prompt instead (code-audit 2026-07-18 §6.3).
function normalizeParse(raw: unknown): ParsedPrompt {
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string) =>
    typeof v === "string" && v.trim() !== "" ? v : fallback;
  const strArray = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  return {
    time_window: str(o.time_window, "unspecified"),
    stop_count: typeof o.stop_count === "number" ? o.stop_count : null,
    aesthetic: str(o.aesthetic, "unspecified"),
    category_signals: strArray(o.category_signals),
    group_context: str(o.group_context, "unspecified"),
    budget: typeof o.budget === "string" && o.budget.trim() !== "" ? o.budget : null,
    constraints: strArray(o.constraints),
    // "" is the documented "no neighbourhood stated" value
    location: typeof o.location === "string" ? o.location : "",
  };
}

export async function POST(request: NextRequest) {
  let prompt: string;
  try {
    const body = await request.json();
    prompt = body?.prompt;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400 }
    );
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return NextResponse.json(
      { error: "`prompt` (non-empty string) is required in the body." },
      { status: 400 }
    );
  }

  // e2e fixture seam — deterministic parse, no Groq call, no key needed
  if (isMockMode()) return NextResponse.json(mockParse(prompt));

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not set." },
      { status: 500 }
    );
  }

  let raw = "";
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        // Belt and braces: the system prompt demands bare JSON, and
        // response_format guarantees the model can't wrap it in prose.
        response_format: { type: "json_object" },
        temperature: 0,
      }),
      cache: "no-store",
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        {
          error: `Groq request failed (${res.status}).`,
          details: data?.error?.message ?? data,
        },
        { status: 500 }
      );
    }

    raw = data?.choices?.[0]?.message?.content ?? "";
    return NextResponse.json(normalizeParse(JSON.parse(raw)));
  } catch (err) {
    return NextResponse.json(
      {
        error: UNPARSEABLE_MESSAGE,
        detail: "Failed to parse Groq response as JSON.",
        details: err instanceof Error ? err.message : String(err),
        raw, // surfaced so prompt-formatting issues are debuggable
      },
      { status: 500 }
    );
  }
}
