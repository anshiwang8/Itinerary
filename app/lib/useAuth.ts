"use client";

// Auth state for the UI, in one hook.
//
// Deliberately minimal — this slice CAPTURES an identity and nothing more. No
// context provider, because exactly one component needs this today and a
// provider would be scaffolding for a stage that hasn't been designed yet.
//
// The invariant that shapes every branch below: a guest and a signed-in user
// get identical app behaviour. Nothing here gates a feature, and every failure
// path lands on "signed-out", which is a fully working state — never a spinner
// that outlives its answer.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { getFirebaseAuth, isFirebaseConfigured } from "./firebase";
import { toAppUser, type AppUser } from "./authUser";

export type AuthStatus = "loading" | "signed-in" | "signed-out";

export interface AuthState {
  status: AuthStatus;
  user: AppUser | null;
  /** Whether sign-in can be OFFERED. False means Firebase is unconfigured —
   *  the guest path is unaffected, so this disables a button, nothing more. */
  available: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
  /**
   * A fresh Firebase ID token for authenticating a request to our own API,
   * or null when there is no session. The SERVER verifies it — this is the
   * only thing a route will accept as identity, because a uid in a body is
   * just a string the browser chose.
   */
  getIdToken: () => Promise<string | null>;
}

/** Popup closures are the user changing their mind, not a failure to report. */
const SILENT_CODES = new Set([
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/user-cancelled",
]);

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

export function useAuth(): AuthState {
  // Read once: NEXT_PUBLIC_ values are build-time constants, so this is stable
  // and identical on the server and the client — no hydration mismatch.
  const available = useMemo(() => isFirebaseConfigured(), []);
  const [status, setStatus] = useState<AuthStatus>(available ? "loading" : "signed-out");
  const [user, setUser] = useState<AppUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!auth) {
      // Unconfigured, or the SDK refused to start. Either way there is no
      // session to wait for and the app is fully usable as a guest.
      //
      // When Firebase is simply absent this is already the initial state and
      // the write is a no-op. It matters only in the rare case where the
      // config LOOKS complete but the SDK threw — without it the UI would
      // wait on a session that is never coming. Deferred to a frame rather
      // than written synchronously, the same way ItineraryMap's projection
      // probe defers its own setState, because a synchronous write inside an
      // effect is a cascading render.
      const frame = requestAnimationFrame(() => setStatus("signed-out"));
      return () => cancelAnimationFrame(frame);
    }
    // onAuthStateChanged (not a one-shot read) is what recognises a returning
    // signed-in user on load; Firebase's own session persistence supplies it.
    return onAuthStateChanged(
      auth,
      (firebaseUser) => {
        const mapped = toAppUser(firebaseUser);
        if (!mapped) {
          // NOBODY is signed in — so sign them in ANONYMOUSLY, silently.
          //
          // This is Stage 1B's "one id path, not two branches": from here on
          // every visitor has a uid, and the only question is whether it is a
          // guest's or an account's. It buys the guest a plan that survives a
          // refresh, which is the actual bug being fixed.
          //
          // No popup, no UI change, nothing to notice. If it fails (offline,
          // provider disabled) we land on "signed-out", which is still the
          // fully working pre-1B app — the plan just won't follow a refresh.
          setUser(null);
          setStatus("signed-out");
          void signInAnonymously(auth).catch(() => {
            // Deliberately silent: a guest never asked for this and must not
            // be shown an error about an account they did not want.
          });
          return;
        }
        setUser(mapped);
        setStatus("signed-in");
      },
      () => {
        // A listener error must not strand the UI on "loading" forever.
        setUser(null);
        setStatus("signed-out");
      }
    );
  }, []);

  const signIn = useCallback(async () => {
    const auth = getFirebaseAuth();
    if (!auth) {
      setError("Sign-in is unavailable right now. You can keep going as a guest.");
      return;
    }
    setError(null);
    const current = auth.currentUser;
    try {
      if (current?.isAnonymous) {
        // UPGRADE the guest rather than replacing them: linking keeps the SAME
        // uid, so the plan they are in the middle of stays theirs. A plain
        // signInWithPopup here would mint a different uid and silently orphan
        // the active plan — a visible regression against "plans survive".
        await linkWithPopup(current, new GoogleAuthProvider());
      } else {
        await signInWithPopup(auth, new GoogleAuthProvider());
      }
      // No setState here: onAuthStateChanged is the single source of truth for
      // who is signed in, so the popup result never gets to disagree with it.
    } catch (caught) {
      if (SILENT_CODES.has(errorCode(caught))) return;
      // This Google account already exists, so there is nothing to link TO —
      // the anonymous uid cannot absorb an identity that is already someone
      // else's. Sign in as that existing account instead; the guest's
      // in-progress plan does not carry over, which is correct: it belongs to
      // the guest, and this is a different, older person.
      if (errorCode(caught) === "auth/credential-already-in-use") {
        try {
          await signInWithPopup(auth, new GoogleAuthProvider());
          return;
        } catch (retry) {
          if (SILENT_CODES.has(errorCode(retry))) return;
        }
      }
      setError("Could not sign in with Google. Please try again.");
    }
  }, []);

  const signOut = useCallback(async () => {
    const auth = getFirebaseAuth();
    if (!auth) return;
    try {
      await firebaseSignOut(auth);
    } catch {
      setError("Could not sign out. Please try again.");
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const getIdToken = useCallback(async (): Promise<string | null> => {
    const auth = getFirebaseAuth();
    const current = auth?.currentUser;
    if (!current) return null;
    try {
      // The SDK caches and refreshes this; asking per request is cheap and
      // avoids shipping a token that expired while a plan was open.
      return await current.getIdToken();
    } catch {
      // No token means the request goes out unauthenticated, which every
      // route already handles as guest-level. Never a hard failure.
      return null;
    }
  }, []);

  return { status, user, available, error, signIn, signOut, clearError, getIdToken };
}
