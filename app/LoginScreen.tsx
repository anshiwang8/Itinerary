"use client";

// The login screen: a centred card over a dimmed hero — brand, one primary
// action, and a guest path offered as a real choice rather than a consolation.
//
// Discord-style in STRUCTURE only. The palette is this app's: white card
// surface, ink-navy type, Fraunces display, mid-teal accent. Acid green is
// RESERVED for "happening now / just changed" and appears nowhere here.
//
// It is a dismissible overlay, not a gate: the app has always worked without
// an account and still does, so nothing behind this card is locked.
import { useEffect, useRef } from "react";
import type { AuthState } from "./lib/useAuth";

/** Google's four-colour G. Their branding guidance wants the mark unaltered
 *  on a light button, so this is drawn rather than themed. */
function GoogleMark() {
  return (
    <svg className="auth__g" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

export default function LoginScreen({
  auth,
  onDismiss,
}: {
  auth: AuthState;
  /** Closes the screen. Dismissing WITHOUT signing in is exactly the guest
   *  path — "no account" is this app's normal state, not an escape hatch. */
  onDismiss: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const guestRef = useRef<HTMLButtonElement>(null);
  // A REAL account, not the anonymous session every visitor now gets on load.
  // Keying off `status === "signed-in"` alone would make this screen dismiss
  // itself the instant it opened, since a guest is already signed in.
  const signedIn = auth.status === "signed-in" && auth.user?.isAnonymous === false;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  // The popup resolving is the end of this screen's job. Closing is driven off
  // auth STATE rather than the popup's return value, so the screen and the
  // account corner can never disagree about who is signed in.
  useEffect(() => {
    if (signedIn) onDismiss();
  }, [signedIn, onDismiss]);

  // Move focus into the card so keyboard users land inside the dialog rather
  // than behind it. The guest button is the safe default target.
  useEffect(() => {
    guestRef.current?.focus();
  }, []);

  const busy = auth.status === "loading";

  return (
    <div className="auth" role="presentation">
      <div
        className="auth__card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
        aria-describedby="auth-sub"
      >
        <div className="auth__brand">
          <div className="auth__mark" aria-hidden="true">
            Itinerary
          </div>
          <h2 className="auth__title" id="auth-title">
            Welcome
          </h2>
          <p className="auth__sub" id="auth-sub">
            Sign in to keep your plans with you — or carry on without an account.
          </p>
        </div>

        <button
          type="button"
          className="auth__google"
          onClick={() => void auth.signIn()}
          disabled={!auth.available || busy}
        >
          <GoogleMark />
          <span>Continue with Google</span>
        </button>

        {!auth.available && (
          <p className="auth__note" role="status">
            Sign-in is unavailable right now. Everything below still works.
          </p>
        )}

        {auth.error && (
          <p className="auth__err" role="alert">
            {auth.error}
          </p>
        )}

        <div className="auth__or" aria-hidden="true">
          <span>or</span>
        </div>

        <button type="button" className="auth__guest" onClick={onDismiss} ref={guestRef}>
          Continue as guest
        </button>
        <p className="auth__fine">
          Guests get the whole app. An account only saves who you are.
        </p>
      </div>
    </div>
  );
}
