import { NextRequest, NextResponse } from "next/server";
import { createItinerary } from "./store";
import { ScheduledStop } from "../schedule/schedule";
import { TravelLeg } from "../schedule/travel";

// POST /api/itinerary — store the full pipeline output, return { id }.
export async function POST(request: NextRequest) {
  let stops: ScheduledStop[];
  let legs: TravelLeg[];
  try {
    const body = await request.json();
    stops = body?.stops;
    legs = Array.isArray(body?.legs) ? body.legs : [];
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400 }
    );
  }
  if (!Array.isArray(stops) || stops.length === 0) {
    return NextResponse.json(
      { error: "`stops` (non-empty array of scheduled stops) is required." },
      { status: 400 }
    );
  }

  const itinerary = createItinerary(stops, legs);
  return NextResponse.json({ id: itinerary.id });
}
