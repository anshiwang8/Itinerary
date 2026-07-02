import { NextRequest, NextResponse } from "next/server";

// Standalone LLM parse step: natural-language prompt → structured plan
// parameters. Not connected to Places yet — this route only proves Groq
// returns clean, schema-matching JSON.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are a parser for a day-plan generator. Convert the user's request into JSON.

Respond with ONLY a single JSON object. No prose, no explanations, no markdown fences, no leading or trailing text. The object must match this exact schema — every key present, no extra keys:

{
  "time_window": string,        // e.g. "afternoon, 3 hours". Best-effort description of when and how long; if the user gives no time information, describe what they implied or "unspecified"
  "stop_count": number | null,  // ONLY if the user explicitly states a number of stops/places; otherwise null. Do not infer.
  "aesthetic": string,          // the vibe/mood the user wants, e.g. "cozy", "lively night out", "quiet and scenic"
  "category_signals": string[], // place/activity categories implied, e.g. ["coffee shop", "bookstore", "park"]
  "group_context": string,      // who is going, e.g. "solo", "date", "family with kids", "group of friends"; "unspecified" if unknown
  "budget": string | null,      // budget signal if stated, e.g. "cheap", "under $50", "$$$"; null if unstated
  "constraints": string[],      // hard requirements, e.g. ["wheelchair accessible", "vegetarian options", "indoors only"]; [] if none
  "location": string            // neighbourhood/area; default "Ossington" if the user does not state one
}`;

export async function POST(request: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not set." },
      { status: 500 }
    );
  }

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
