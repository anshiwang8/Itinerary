"use client";

// The React binding for `liveTracking.ts`. Deliberately thin: all of the
// state machine, the visibility pause/resume and the staleness heartbeat
// live in the pure module. This hook only mirrors its state into React and
// ties the tracker's lifetime to one `enabled` flag.
//
// LIFECYCLE — clearWatch runs on every one of the paths CLAUDE.md's Piece 1
// spec names:
//   - tab hidden        -> inside the module (visibilitychange -> endWatch)
//   - user stops        -> consumer flips `enabled` false -> effect cleanup
//   - unmount           -> effect cleanup
//   - plan end          -> consumer passes `enabled={want && !!itinerary}`,
//                          so the plan ending flips it false -> effect cleanup

import { useEffect, useRef, useState } from "react";
import {
  createLiveTracker,
  INITIAL_LIVE_TRACKING_STATE,
  type LiveTracker,
  type LiveTrackingState,
} from "./liveTracking";

/**
 * @param enabled          begin tracking while true; stop (and reset to
 *                         "off") when it goes false or the component
 *                         unmounts.
 * @param onTransition     optional side-channel for every state change
 *                         (e.g. a dev-only console log). Held in a ref so
 *                         changing its identity never restarts the tracker.
 */
export function useLiveTracking(
  enabled: boolean,
  onTransition?: (state: LiveTrackingState) => void
): LiveTrackingState {
  const [state, setState] = useState<LiveTrackingState>(INITIAL_LIVE_TRACKING_STATE);
  const onTransitionRef = useRef(onTransition);
  useEffect(() => {
    onTransitionRef.current = onTransition;
  }, [onTransition]);

  useEffect(() => {
    if (!enabled) return;
    const tracker: LiveTracker = createLiveTracker((next) => {
      setState(next);
      onTransitionRef.current?.(next);
    });
    tracker.start();
    return () => {
      // Stops the watch, the heartbeat and the visibility listener.
      tracker.stop();
      setState(INITIAL_LIVE_TRACKING_STATE);
    };
  }, [enabled]);

  return state;
}
