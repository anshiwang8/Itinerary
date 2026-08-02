// Firebase Admin — SERVER ONLY. Never imported from a client component.
//
// This is the other half of 1A's client SDK: the browser says who it is, and
// this decides whether to believe it. A uid in a request body is a claim; a
// verified ID token is evidence. Nothing in this codebase may stamp or archive
// on the strength of a claim.
//
// Credentials are a SERVICE ACCOUNT and are secret — deliberately NOT
// NEXT_PUBLIC_, unlike the six client config values, which are not secrets at
// all. Three env vars, straight off the service-account JSON:
//
//   FIREBASE_ADMIN_PROJECT_ID
//   FIREBASE_ADMIN_CLIENT_EMAIL
//   FIREBASE_ADMIN_PRIVATE_KEY
//
// RESILIENCE, mirroring firebase.ts: absent credentials degrade, they do not
// throw. Every entry point returns null, the caller is then treated as
// UNAUTHENTICATED, and unauthenticated is a fully working guest-level state.
// The one thing that must never happen is the opposite — falling back to
// trusting an unverified uid, which would turn a missing env var into an
// impersonation hole.
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

interface AdminCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

function readCredentials(): AdminCredentials | null {
  const projectId = nonEmpty(process.env.FIREBASE_ADMIN_PROJECT_ID);
  const clientEmail = nonEmpty(process.env.FIREBASE_ADMIN_CLIENT_EMAIL);
  const rawKey = nonEmpty(process.env.FIREBASE_ADMIN_PRIVATE_KEY);
  if (!projectId || !clientEmail || !rawKey) return null;

  // A PEM key carries real newlines. Dashboards and .env files usually can't,
  // so the value arrives with literal "\n" two-character sequences; both forms
  // have to work or the key silently fails to parse at verify time.
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  return { projectId, clientEmail, privateKey };
}

/** Whether server-side verification can run at all. Used for one clear log
 *  line at the boundary, so "nobody is ever authenticated" is diagnosable
 *  rather than mysterious. */
export function isAdminConfigured(): boolean {
  return readCredentials() !== null;
}

let resolved = false;
let cachedApp: App | null = null;

function adminApp(): App | null {
  if (resolved) return cachedApp;
  resolved = true;
  const credentials = readCredentials();
  if (!credentials) return null;
  try {
    cachedApp =
      getApps().find((a) => a.name === "itinerary-admin") ??
      initializeApp(
        {
          credential: cert({
            projectId: credentials.projectId,
            clientEmail: credentials.clientEmail,
            privateKey: credentials.privateKey,
          }),
        },
        // A named app so this can never collide with anything else that
        // initialises the default admin app.
        "itinerary-admin"
      );
  } catch {
    // A malformed key must not take the route down; it makes verification
    // unavailable, which the caller already knows how to handle.
    cachedApp = null;
  }
  return cachedApp;
}

/** The verified subject of an ID token, or null when it cannot be trusted. */
export interface VerifiedToken {
  uid: string;
  isAnonymous: boolean;
}

/**
 * Verify a Firebase ID token. Returns null for every failure — missing
 * credentials, expired token, wrong project, garbage string — because the
 * caller's response to all of them is identical: treat this request as
 * unauthenticated. Distinguishing them would only leak detail to whoever sent
 * the bad token.
 */
export async function verifyIdToken(idToken: string): Promise<VerifiedToken | null> {
  const app = adminApp();
  if (!app) return null;
  const token = idToken.trim();
  if (token.length === 0) return null;
  try {
    const decoded = await getAuth(app).verifyIdToken(token);
    const uid = typeof decoded.uid === "string" ? decoded.uid.trim() : "";
    if (uid.length === 0) return null;
    // The provider is what separates a guest from an account, and it comes
    // from the SIGNED token rather than from anything the browser asserts.
    return { uid, isAnonymous: decoded.firebase?.sign_in_provider === "anonymous" };
  } catch {
    return null;
  }
}

/** Firestore handle for the history archive, or null when unconfigured.
 *  Null is a skip, never a throw — history is additive, and failing to write
 *  it must not fail the request that noticed the plan had concluded. */
export function getAdminFirestore(): Firestore | null {
  const app = adminApp();
  if (!app) return null;
  try {
    return getFirestore(app);
  } catch {
    return null;
  }
}
