import { NextRequest, NextResponse } from "next/server";
import { loadItinerary, saveItinerary } from "../../store";
import { swapStop } from "../../swap";

// POST /api/itinerary/[id]/swap
// body: { stopIndex: number, refinement: string, now?: ISO }
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  let itinerary;
  try {
    itinerary = await loadItinerary(params.id);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
  if (!itinerary) {
    return NextResponse.json(
      { error: `No itinerary with id "${params.id}".` },
      { status: 404 }
    );
  }

  let stopIndex: number;
  let refinement: string;
  let nowISO: string | undefined;
  try {
    const body = await request.json();
    stopIndex = body?.stopIndex;
    refinement = body?.refinement;
    nowISO = body?.now;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (typeof stopIndex !== "number" || !Number.isInteger(stopIndex) || stopIndex < 0) {
    return NextResponse.json(
      { error: "`stopIndex` must be a non-negative integer." },
      { status: 400 }
    );
  }
  if (typeof refinement !== "string" || refinement.trim() === "") {
    return NextResponse.json(
      { error: "`refinement` must be a non-empty string." },
      { status: 400 }
    );
  }
  let now = new Date();
  if (nowISO !== undefined) {
    now = new Date(nowISO);
    if (isNaN(now.getTime())) {
      return NextResponse.json(
        { error: "`now` must be a valid ISO timestamp." },
        { status: 400 }
      );
    }
  }

  try {
    const result = await swapStop(itinerary, stopIndex, refinement.trim(), now);
    // statuses/lock ratchet mutate even on a refusal — always write back
    await saveItinerary(itinerary);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Swap failed.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
