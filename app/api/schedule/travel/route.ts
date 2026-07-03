import { NextRequest, NextResponse } from "next/server";
import { getTravelLegs, LatLng } from "../travel";

// POST { points: LatLng[], departureTime?: string } → { legs: TravelLeg[] }
export async function POST(request: NextRequest) {
  const apiKey = process.env.GOOGLE_ROUTES_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_ROUTES_API_KEY is not set." },
      { status: 500 }
    );
  }

  let points: LatLng[];
  let departureTime: string | undefined;
  try {
    const body = await request.json();
    points = body?.points;
    departureTime = body?.departureTime;
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
    const legs = await getTravelLegs(apiKey, points, departureTime);
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
