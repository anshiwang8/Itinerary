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
    // the locked ratchet mutates — persist it, or backwards time travel on
    // another instance could unlock a stop. But ONLY when something
    // actually moved: this route is polled (the dev time picker fires a GET
    // per change), and an unconditional write was a Redis round trip per
    // read that also refreshed the TTL, so an actively-viewed plan never
    // expired (code-audit 2026-07-18 §2.4).
    const touched = { changed: false };
    const result = withStatuses(itinerary, t, touched);
    if (touched.changed) await saveItinerary(result);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
