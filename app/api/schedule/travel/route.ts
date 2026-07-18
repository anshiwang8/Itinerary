import { NextRequest, NextResponse } from "next/server";
import { getTravelLegs, LatLng } from "../travel";
import { isMockMode, mockTravelLegs } from "../../_mock/fixtures";

// POST { points: LatLng[], departureTime?: string, dwellMinutes?: number[] }
//   → { legs: TravelLeg[] }
// dwellMinutes[i] = how long the traveller stays at points[i] (index 0 is
// home, no dwell) so each leg can be routed at its own departure instant.
export async function POST(request: NextRequest) {
  const apiKey = process.env.GOOGLE_ROUTES_API_KEY;
  if (!apiKey && !isMockMode()) {
    return NextResponse.json(
      { error: "GOOGLE_ROUTES_API_KEY is not set." },
      { status: 500 }
    );
  }

  let points: LatLng[];
  let departureTime: string | undefined;
  let dwellMinutes: number[] | undefined;
  try {
    const body = await request.json();
    points = body?.points;
    departureTime = body?.departureTime;
    dwellMinutes = Array.isArray(body?.dwellMinutes)
      ? body.dwellMinutes.filter((n: unknown): n is number => typeof n === "number")
      : undefined;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400 }
    );
  }
  if (
    !Array.isArray(points) ||
    points.some(
      (p) => typeof p?.latitude !== "number" || typeof p?.longitude !== "number"
    )
  ) {
    return NextResponse.json(
      { error: "`points` must be an array of { latitude, longitude }." },
      { status: 400 }
    );
  }

  try {
    // fixture seam: deterministic distance-derived legs, no Routes call
    if (isMockMode()) {
      return NextResponse.json({ legs: mockTravelLegs(points) });
    }
    const legs = await getTravelLegs(apiKey!, points, departureTime, dwellMinutes);
    return NextResponse.json({ legs });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Travel time lookup failed.",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
