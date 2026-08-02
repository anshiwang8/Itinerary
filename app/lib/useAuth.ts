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
  signInWithCredential,
  signInWithPopup,
  signOut as firebaseSignOut,
  type AuthError,
} from "firebase/auth";
import { getFirebaseAuth, isFirebaseConfigured } from "./firebase";
import { toAppUser, type AppUser } from "./authUser";
import { shouldShowDevControls } from "./devControls";

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

/**
 * Linking an anonymous user to a Google account that ALREADY EXISTS. The
 * anonymous uid cannot absorb an identity that is already someone else's, so
 * the right outcome is to sign in as that existing (older) account — its
 * history is the real one, and the guest's in-progress plan belongs to the
 * guest, not to it.
 */
const LINK_CONFLICT_CODES = new Set([
  "auth/credential-already-in-use",
  "auth/email-already-in-use",
]);

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The line that makes a future failure diagnosable.
 *
 * Every auth error used to collapse into one friendly sentence, so "sign-in
 * is broken" carried no information at all — the actual `auth/…` code, the
 * one thing that identifies the fault, was thrown away. It is always logged
 * now, including the codes that are silent in the UI: a popup that reports
 * itself closed when nobody closed it is exactly the kind of thing worth
 * seeing in a console.
 */
function logAuthFailure(stage: string, error: unknown): void {
  console.error(
    `[auth] ${stage} failed — code=${errorCode(error) || "(none)"} message=${errorMessage(error)}`
  );
}

/** Whether to show the raw code to the person looking at the screen. Same
 *  gate the dev time-sim uses: automatic outside production, explicit opt-in
 *  inside it. Users get a sentence; developers get the code too. */
function devVisible(): boolean {
  return shouldShowDevControls(
    process.env.NODE_ENV,
    process.env.NEXT_PUBLIC_ENABLE_DEV_CONTROLS
  );
}

/** A blocked popup is the one auth failure the USER can actually fix, so it
 *  earns its own sentence — "please try again" is useless advice when trying
 *  again does the same thing. */
const MESSAGE_BY_CODE: Record<string, string> = {
  "auth/popup-blocked":
    "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.",
};

function friendly(base: string, code: string): string {
  const message = MESSAGE_BY_CODE[code] ?? base;
  return devVisible() && code ? `${message} (${code})` : message;
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
          void signInAnonymously(auth).catch((error: unknown) => {
            // Silent to the USER — a guest never asked for this and must not
            // be shown an error about an account they did not want — but NOT
            // silent to the console. If this fails there is no identity, so
            // no plan survives a refresh, and that is worth being able to see.
            logAuthFailure("anonymous-sign-in", error);
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
      const code = errorCode(caught);
      if (SILENT_CODES.has(code)) {
        logAuthFailure("google-sign-in", caught);
        return;
      }

      if (LINK_CONFLICT_CODES.has(code)) {
        // NOT A FAILURE — an EXPECTED control-flow signal.
        //
        // "This Google account already exists" is the normal answer for any
        // returning user signing in from a guest session, and it is the
        // question this branch exists to ask. Nothing is logged as failed
        // here: doing so printed "[auth] google-sign-in failed" during a
        // sign-in that then SUCCEEDED, tripped the dev error overlay, and —
        // worse — made the one line that is supposed to identify a real fault
        // indistinguishable from routine control flow. A log that cries wolf
        // is worth less than no log.
        //
        // THE GESTURE-GAP FIX lives here too. This used to call
        // signInWithPopup again, which opens a SECOND popup after an await,
        // outside the user activation the click granted — browsers block that
        // as `auth/popup-blocked`. The fix is to not open a second popup at
        // all: the failed link ALREADY carries the credential the user
        // approved in the first popup, so exchanging it needs no window and
        // no gesture.
        const credential = GoogleAuthProvider.credentialFromError(caught as AuthError);
        if (credential) {
          try {
            await signInWithCredential(auth, credential);
            // Recovered in full. onAuthStateChanged reports the result, as
            // everywhere else, and NOTHING is logged — a sign-in that
            // succeeds must leave no failure line behind it.
            return;
          } catch (fallback) {
            // The exchange itself failing IS a genuine failure: the expected
            // recovery did not recover.
            logAuthFailure("google-sign-in:credential-exchange", fallback);
            if (SILENT_CODES.has(errorCode(fallback))) return;
            setError(
              friendly("Could not sign in with Google. Please try again.", errorCode(fallback))
            );
            return;
          }
        }
        // A conflict with no credential to exchange is a real dead end —
        // there is nothing left to try, so this one is logged.
        logAuthFailure("google-sign-in:no-credential-on-conflict", caught);
        setError(friendly("Could not sign in with Google. Please try again.", code));
        return;
      }

      // Everything else — popup-blocked, unrecognised codes — is a genuine
      // failure and is logged exactly as before.
      logAuthFailure("google-sign-in", caught);
      setError(friendly("Could not sign in with Google. Please try again.", code));
    }
  }, []);

  const signOut = useCallback(async () => {
    const auth = getFirebaseAuth();
    if (!auth) return;
    try {
      await firebaseSignOut(auth);
    } catch (caught) {
      logAuthFailure("sign-out", caught);
      setError(friendly("Could not sign out. Please try again.", errorCode(caught)));
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
