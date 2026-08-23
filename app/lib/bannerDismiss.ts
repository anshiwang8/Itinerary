// Auto-dismiss timing for the transient success/info banner. Pulled out of
// page.tsx as a framework-agnostic controller (no React) so the part this
// kind of feature usually gets wrong — timer cleanup — can be proven without
// a DOM: a stray timer firing after the banner it was armed for has already
// changed would dismiss the WRONG banner or fire against unmounted state.
//
// A refusal/error banner never touches this at all. page.tsx decides that by
// simply never calling `arm()` for one; the controller itself knows nothing
// about what kind of banner it is driving.

/** How long the banner sits fully visible before it starts to fade. */
export const BANNER_DISMISS_MS = 7000;
/** How long the fade-out itself takes. Mirrored by the `.banner--fading`
 *  transition duration in globals.css — keep the two numbers in sync. */
export const BANNER_FADE_MS = 300;

export interface BannerDismissCallbacks {
  /** The dismiss delay elapsed — start the fade-out visual. */
  onFadeStart: () => void;
  /** The fade finished — the caller clears the banner state. */
  onDismiss: () => void;
}

export interface BannerDismissController {
  /** (Re)start the countdown from a full interval — a fresh banner, or a
   *  hover/focus pause ending. Cancels whatever was pending first, so this
   *  is also the "new banner replaces old" reset. */
  arm: () => void;
  /** Cancel every pending timer: a hover/focus pause beginning, the banner
   *  being replaced or cleared, or the owning component unmounting. Safe to
   *  call when nothing is pending. */
  cancel: () => void;
}

/**
 * One banner's dismiss countdown. `dismissMs`/`fadeMs` are parameters
 * (defaulting to the constants above) purely so tests can use small real
 * delays instead of waiting out the production timing.
 */
export function createBannerDismissController(
  callbacks: BannerDismissCallbacks,
  dismissMs: number = BANNER_DISMISS_MS,
  fadeMs: number = BANNER_FADE_MS
): BannerDismissController {
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    if (fadeTimer !== null) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
  }

  function arm(): void {
    cancel();
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      callbacks.onFadeStart();
      fadeTimer = setTimeout(() => {
        fadeTimer = null;
        callbacks.onDismiss();
      }, fadeMs);
    }, dismissMs);
  }

  return { arm, cancel };
}
