import { NextRequest, NextResponse } from "next/server";
import { isMockMode, mockParse } from "../_mock/fixtures";

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
  "category_signals": string[], // place/activity categories implied, e.g. ["coffee shop", "bookstore", "park"]. Capture EVERY distinct activity in the prompt, one entry each, including non-venue activities: "a walk" → "walk", "shopping" → "shopping", "a stroll in the park" → "park walk". Never merge or drop an activity because it isn't a business type. Preserve specific cuisine/food types as the category — "ramen" stays "ramen", "tacos" stays "tacos", never generalized to "restaurant"
  "group_context": string,      // who is going, e.g. "solo", "date", "family with kids", "group of friends"; "unspecified" if unknown
  "budget": string | null,      // budget signal if stated, e.g. "cheap", "under $50", "$$$"; null if unstated
  "constraints": string[],      // hard requirements, e.g. ["wheelchair accessible", "vegetarian options", "indoors only"]; [] if none
  "location": string            // neighbourhood/area; default "Ossington" if the user does not state one
}`;

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
    const parsed = JSON.parse(raw);
    return NextResponse.json(parsed);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to parse Groq response as JSON.",
        details: err instanceof Error ? err.message : String(err),
        raw, // surfaced so prompt-formatting issues are debuggable
      },
      { status: 500 }
    );
  }
}
