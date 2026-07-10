import { NextRequest, NextResponse } from "next/server";
import { loadItinerary, saveItinerary } from "../../store";
import { Disruption, rerouteItinerary } from "../../reroute";

// POST /api/itinerary/[id]/reroute
// body: { disruption: { type: "transit_cancelled", legIndex }, now?: ISO }
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

  let disruption: Disruption;
  let nowISO: string | undefined;
  try {
    const body = await request.json();
    disruption = body?.disruption;
    nowISO = body?.now;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400 }
    );
  }
  if (
    !disruption ||
    disruption.type !== "transit_cancelled" ||
    typeof disruption.legIndex !== "number"
  ) {
    return NextResponse.json(
      { error: "`disruption` must be { type: \"transit_cancelled\", legIndex: number }." },
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
    const result = await rerouteItinerary(itinerary, disruption, now);
    // statuses/lock ratchet mutate even when nothing reroutes — write back
    await saveItinerary(itinerary);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Reroute failed.",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
