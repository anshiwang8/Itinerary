import { NextRequest } from "next/server";
import { readHistoryForOwner } from "../itinerary/history";
import { verifyCaller } from "../_shared/caller";
import { apiError, apiJson, enforceRateLimit, requestContext } from "../_shared/http";

// GET /api/history — the caller's own archived plans, newest first.
//
// WHY IT SITS AT THE TOP LEVEL rather than under /api/itinerary: the writer is
// `app/api/itinerary/history.ts`, so a route folder of the same name would put
// `history.ts` and `history/` side by side and leave `../history` resolving by
// file-before-directory precedence. It resolves correctly today; it is the
// kind of thing that breaks quietly when a bundler changes its mind. The
// top-level noun also matches every other route here (/api/parse, /api/places,
// /api/weather, /api/geocode).
//
// THE CONTRACT: this endpoint never fails because of who is asking. A guest, a
// visitor with no token, a deployment with no Firebase — all get 200 and an
// empty list, because all three genuinely HAVE no history. Stage 1B never
// wrote one for them. Mock e2e runs in exactly that state, and this route must
// be as unremarkable there as every other read.
//
// READ-ONLY, and there is no companion writer here on purpose: this stage adds
// no way to delete, edit, replay or resume an archived plan.
export async function GET(request: NextRequest) {
  const ctx = requestContext(request, "history_read");
  try {
    enforceRateLimit(ctx, 120);

    // Identity from the verified token, NEVER from a query parameter. There is
    // deliberately no `?uid=` on this route: the one uid it will read is the
    // one the server proved, so no request can ask for someone else's outings.
    const caller = await verifyCaller(request);
    if (!caller) {
      // Not an error, and not a lie either — a caller with no verified
      // identity has nothing filed under it. Deliberately unlogged: this is
      // the ordinary state for every guest and every mock-e2e request, and a
      // line per poll would bury the reads that actually touched Firestore.
      // `caller.ts` still logs a token it could not check, once per process.
      return apiJson(ctx, { plans: [], readFailed: false });
    }

    // Anonymous callers are NOT special-cased. A guest's plan is never
    // archived, so their query comes back empty on its own; adding a second
    // gate here would be a duplicate of the write-side promise, free to drift
    // from it. The reader simply answers "what is filed under you".
    const { plans, readFailed } = await readHistoryForOwner(caller.uid);
    return apiJson(ctx, { plans, readFailed });
  } catch (err) {
    // Only the rate limiter can land here — the read itself is non-throwing.
    return apiError(ctx, err);
  }
}
