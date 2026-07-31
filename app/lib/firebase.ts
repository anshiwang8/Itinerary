// Firebase client init — DELIBERATELY UNABLE TO TAKE THE APP DOWN.
//
// This app works with no account at all, and that has to stay true. A preview
// build with no Firebase keys, or a deploy that lands before its env vars do,
// must degrade to "sign-in unavailable" and nothing else — never a white
// screen, never a broken landing page. So every entry point here returns null
// instead of throwing, and the module does NO work at import time: reading a
// missing key is not an error, it is an answer.
//
// This is the same bargain the rest of the codebase makes with missing data
// (keep-on-missing in the filters, the deterministic planner fallback): the
// absence of an optional input degrades one feature, never the request.
//
// NEXT_PUBLIC_ vars are inlined by the bundler at BUILD time, and only when
// written as complete static expressions — `process.env[someKey]` yields
// undefined in the browser. That is why the six reads below are spelled out
// literally rather than looped over a key list.
import { getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

/** Treats "" and whitespace as absent — a blank env var in a hosting
 *  dashboard is a missing one, not a configured empty string. */
function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function readConfig(): FirebaseOptions | null {
  const apiKey = nonEmpty(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);
  const authDomain = nonEmpty(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN);
  const projectId = nonEmpty(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);
  const storageBucket = nonEmpty(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET);
  const messagingSenderId = nonEmpty(process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID);
  const appId = nonEmpty(process.env.NEXT_PUBLIC_FIREBASE_APP_ID);

  // All six or none. A partial config fails deep inside the SDK at popup time
  // with an opaque message; refusing it here turns that into a clean
  // "sign-in unavailable" the UI can actually explain.
  if (!apiKey || !authDomain || !projectId || !storageBucket || !messagingSenderId || !appId) {
    return null;
  }
  return { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId };
}

/** Whether sign-in can be offered at all. Safe during SSR and render — it
 *  only reads build-time constants. */
export function isFirebaseConfigured(): boolean {
  return readConfig() !== null;
}

let resolved = false;
let cachedAuth: Auth | null = null;

/**
 * The Auth instance, or null when Firebase is unconfigured or failed to
 * start. Callers MUST handle null — that is the degraded path, not an error.
 *
 * The SSR bail-out deliberately happens BEFORE `resolved` is set: caching a
 * server-side null would poison the client, where the answer is different.
 */
export function getFirebaseAuth(): Auth | null {
  if (typeof window === "undefined") return null;
  if (resolved) return cachedAuth;
  resolved = true;

  const config = readConfig();
  if (!config) return null;

  try {
    const app: FirebaseApp = getApps()[0] ?? initializeApp(config);
    cachedAuth = getAuth(app);
  } catch {
    // A malformed key, a blocked origin, a storage-partitioned browser: none
    // of these are worth a crash when the whole feature is optional.
    cachedAuth = null;
  }
  return cachedAuth;
}
