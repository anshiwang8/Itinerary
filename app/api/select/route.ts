import { NextRequest, NextResponse } from "next/server";
import { ParsedPrompt, Place } from "../places/search/filter";
import { SelectParseError, selectVenues } from "./selectVenues";
import { isMockMode, mockSelect } from "../_mock/fixtures";

// Thin wrapper over selectVenues (shared with the reroute engine).
export async function POST(request: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey && !isMockMode()) {
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

  try {
    // fixture seam: deterministic highest-rated pick, no Groq call
    if (isMockMode()) {
      return NextResponse.json({ selections: mockSelect(parsed, poolsIn) });
    }
    const selections = await selectVenues(apiKey!, parsed, poolsIn);
    return NextResponse.json({ selections });
  } catch (err) {
    if (err instanceof SelectParseError) {
      return NextResponse.json(
        { error: err.message, raw: err.raw },
        { status: 500 }
      );
    }
    return NextResponse.json(
      {
        error: "Selection failed.",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
