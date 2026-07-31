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
  onAuthStateChanged,
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
        setUser(mapped);
        setStatus(mapped ? "signed-in" : "signed-out");
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
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      // No setState here: onAuthStateChanged is the single source of truth for
      // who is signed in, so the popup result never gets to disagree with it.
    } catch (caught) {
      if (SILENT_CODES.has(errorCode(caught))) return;
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

  return { status, user, available, error, signIn, signOut, clearError };
}
