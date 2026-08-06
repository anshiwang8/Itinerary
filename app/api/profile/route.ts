import { NextRequest } from "next/server";
import { readTasteProfile, writeTasteProfile } from "./profileStore";
import { verifyCaller } from "../_shared/caller";
import {
  ApiError,
  apiError,
  apiJson,
  enforceRateLimit,
  isRecord,
  readJsonBody,
  requestContext,
} from "../_shared/http";
import { normalizeTasteAnswers } from "../../lib/tastePreferences";

// /api/profile — the onboarding taste survey's storage.
//
// GET  → the caller's own profile, or null. Decides whether to ASK.
// POST → files the answers (or the skip). Decides that they are never asked
//        again.
//
// CAPTURE ONLY (Stage 3A). No route in the planning pipeline imports anything
// from here, and none should until 3B. This endpoint stores taste; it does not
// spend it.
//
// THE CONTRACT, inherited from /api/history: this endpoint never fails because
// of who is asking. A guest, a visitor with no token, a deployment with no
// Firebase — all get 200. Two reasons that matters more here than usual. Mock
// e2e runs in exactly that state and must not learn a new failure mode; and the
// caller is a survey the user has already dismissed, so a 401 would be an error
// dialog about a form that is no longer on screen.
//
// Identity comes from the verified Bearer token and NOWHERE else. There is
// deliberately no `?uid=` and no uid in the body: a profile is the most
// personal thing this app stores, and the only one it will read or write is the
// one the server proved.

export async function GET(request: NextRequest) {
  const ctx = requestContext(request, "profile_read");
  try {
    enforceRateLimit(ctx, 120);

    const caller = await verifyCaller(request);
    if (!caller) {
      // No verified identity has no profile — the same shape a signed-in user
      // with nothing stored gets, because it is the same truth. Deliberately
      // unlogged: this is the ordinary state of every guest and every mock-e2e
      // request, and `caller.ts` already logs a token it could not check.
      return apiJson(ctx, { profile: null, readFailed: false });
    }

    // Anonymous callers are NOT special-cased, matching the history reader: a
    // guest's profile is never written, so their read comes back empty on its
    // own. A second gate here would duplicate the write-side promise and be
    // free to drift from it. (Note the uid SURVIVES an upgrade — linkWithPopup
    // keeps it — so a guest who signs in reads back the same empty path and is
    // correctly offered the survey.)
    const { profile, readFailed } = await readTasteProfile(caller.uid);
    return apiJson(ctx, { profile, readFailed });
  } catch (err) {
    // Only the rate limiter can land here — the read itself is non-throwing.
    return apiError(ctx, err);
  }
}

export async function POST(request: NextRequest) {
  const ctx = requestContext(request, "profile_write");
  try {
    enforceRateLimit(ctx, 60);

    const body = await readJsonBody(request);
    if (!isRecord(body) || typeof body.completed !== "boolean") {
      // A malformed body IS a client bug worth naming — but note what is NOT
      // validated: the answer arrays. Those go through `normalizeTasteAnswers`,
      // which drops anything outside the survey's closed option set. A stale
      // client sending a retired option loses that option, not its submission.
      throw new ApiError(
        400,
        "invalid_profile_body",
        "`completed` must be true (submitted) or false (skipped)."
      );
    }

    const caller = await verifyCaller(request);
    // NOT a 401. A write with no verified identity has nowhere to go, and
    // saying so as an error would break mock e2e (no Firebase at all) and
    // surface a dialog for a survey the user has already closed. `saved: false`
    // is the honest answer and the client treats it as "carry on".
    if (!caller) return apiJson(ctx, { saved: false });

    // THE GATE OF THE SLICE, and the one place it is enforced: a guest has no
    // account to save to. The client already declines to show the survey to
    // one, but that is a UI decision made in a browser — this is the check that
    // is actually load-bearing, and it reads anonymity from the SIGNED token
    // rather than from anything the request claimed.
    if (caller.isAnonymous) return apiJson(ctx, { saved: false });

    const saved = await writeTasteProfile(
      caller.uid,
      normalizeTasteAnswers(body.answers),
      body.completed
    );
    return apiJson(ctx, { saved });
  } catch (err) {
    return apiError(ctx, err);
  }
}
