// Who is making this request — the ONE place a route learns that.
//
// The rule this file exists to enforce: identity comes from a verified ID
// token in the Authorization header, never from the request body. A uid in a
// body is something the browser typed; anyone can type a different one. If a
// route ever needs "the caller", it calls this, and if this says null the
// caller is a stranger with guest-level standing.
import type { NextRequest } from "next/server";
import { logEvent } from "./http";
import { isAdminConfigured, verifyIdToken } from "../../lib/firebaseAdmin";
import type { CallerIdentity } from "../itinerary/ownership";

/** Mock e2e runs with no Firebase and no Admin credentials. Its requests are
 *  simply unauthenticated, which is a supported state — the seam is DATA
 *  (no token), not a branch in the logic. */
function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

let warnedUnconfigured = false;

/**
 * The verified caller, or null.
 *
 * Null means one of: no token sent (a guest before anonymous sign-in
 * resolves, or mock e2e), Admin credentials absent, or a token that failed
 * verification. Every one of those is handled the same way by every caller —
 * proceed with no identity — and NONE of them falls back to trusting a
 * client-supplied uid. A missing env var degrades the feature; it does not
 * open a hole.
 */
export async function verifyCaller(request: NextRequest): Promise<CallerIdentity | null> {
  const token = bearerToken(request);
  if (!token) return null;

  if (!isAdminConfigured()) {
    // Once per process, not per request: a token arriving with no way to check
    // it is a deployment problem, and it should be visible without drowning
    // the log in a line per poll.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logEvent("error", "admin_credentials_missing", {
        detail:
          "An ID token was sent but FIREBASE_ADMIN_* credentials are unset — " +
          "requests are being treated as unauthenticated. Plans will not be " +
          "owned, resumed, or archived until these are configured.",
      });
    }
    return null;
  }

  const verified = await verifyIdToken(token);
  if (!verified) {
    logEvent("error", "caller_token_rejected", {});
    return null;
  }
  return { uid: verified.uid, isAnonymous: verified.isAnonymous };
}
