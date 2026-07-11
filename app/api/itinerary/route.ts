import { NextRequest, NextResponse } from "next/server";
import { createItinerary, saveItinerary } from "./store";
import { ScheduledStop } from "../schedule/schedule";
import { TravelLeg } from "../schedule/travel";
import { HomePoint } from "../schedule/home";
import { ParsedPrompt } from "../places/search/filter";

// POST /api/itinerary — store the full pipeline output, return { id }.
export async function POST(request: NextRequest) {
  let stops: ScheduledStop[];
  let legs: TravelLeg[];
  let parsed: ParsedPrompt | undefined;
  let homeLeg: TravelLeg | undefined;
  let home: HomePoint | undefined;
  try {
    const body = await request.json();
    stops = body?.stops;
    legs = Array.isArray(body?.legs) ? body.legs : [];
    parsed =
      body?.parsed && typeof body.parsed === "object" ? body.parsed : undefined;
    homeLeg =
      body?.homeLeg && typeof body.homeLeg === "object" ? body.homeLeg : undefined;
    home =
      body?.home && typeof body.home === "object" && body.home.location
        ? body.home
        : undefined;
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

  const itinerary = createItinerary(stops, legs, parsed, homeLeg, home);
  try {
    await saveItinerary(itinerary);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
  return NextResponse.json({ id: itinerary.id });
}
