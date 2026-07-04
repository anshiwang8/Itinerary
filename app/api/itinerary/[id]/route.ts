import { NextRequest, NextResponse } from "next/server";
import { getItinerary, withStatuses } from "../store";

// GET /api/itinerary/[id]?now=ISO — itinerary with statuses computed
// against `now`. The ?now param is the dev time control and the
// backbone of reroute testing: any instant can be simulated.
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const itinerary = getItinerary(params.id);
  if (!itinerary) {
    return NextResponse.json(
      { error: `No itinerary with id "${params.id}".` },
      { status: 404 }
    );
  }

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

  return NextResponse.json(withStatuses(itinerary, t));
}
