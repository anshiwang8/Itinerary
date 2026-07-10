import { NextRequest, NextResponse } from "next/server";
import { loadItinerary, saveItinerary, withStatuses } from "../store";

// GET /api/itinerary/[id]?now=ISO — itinerary with statuses computed
// against `now`. The ?now param is the dev time control and the
// backbone of reroute testing: any instant can be simulated.
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const nowParam = request.nextUrl.searchParams.get("now");
  let t = new Date();
  if (nowParam !== null) {
    const parsed = new Date(nowParam);
    if (isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: "`now` must be a valid ISO timestamp." },
        { status: 400 }
      );
    }
    t = parsed;
  }

  try {
    const itinerary = await loadItinerary(params.id);
    if (!itinerary) {
      return NextResponse.json(
        { error: `No itinerary with id "${params.id}".` },
        { status: 404 }
      );
    }
    const result = withStatuses(itinerary, t);
    // the locked ratchet mutates — persist it or backwards time travel
    // on another instance could unlock a stop
    await saveItinerary(result);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
