# Mobile UI fixes

Branch: `mobile-ui-fix` · 2026-09-08

The approved investigation now has an implementation. Changes are local to this branch; main and production have not been updated.

## What changed

- A held drag keeps its touch ID and screen position when toolbar, notice or viewport dimensions change. Measurements run once per animation frame and reuse one safe-area probe.
- One animation controller drives sheet position, background and content visibility. Cards appear during expansion, and re-grabbing does not reset the background or apply overscroll resistance twice. Slow releases choose the nearest state; flings choose the next state in their direction. Terminal movement, held fingers, unrelated touches and rapid taps have explicit handling.
- The grip and non-interactive header both drag the panel. The heading's view button retains its own action.
- Halfway cards scroll horizontally only. Compact name/time summaries and 44px Details actions fit shorter viewports; complete names, times, ratings, durations, route information and walking cautions remain in the full list. Details opens the corresponding full-list item. The header view toggle preserves the list's existing scroll position.
- The bottom safe-area allowance is reserved once. The halfway layout has a minimum content allowance when the available screen can accommodate it.
- Search controls follow the visible viewport during page zoom and panning. Narrow toolbars place mode controls on a separate row to prevent overlap at 2× zoom. Mobile search/location fields use 16px text. User zoom remains enabled.
- Invisible views remain mounted for scroll retention but become inert. Keyboard controls, reduced motion and focus restoration remain supported.

No scheduling, routing, provider facts, map geometry, server persistence or desktop layout code changed.

## Verification

The new `e2e/mobile-gestures.spec.ts` uses trusted Chromium touch input to exercise continuous dragging, held geometry changes, animation interruption, overscroll, header dragging, horizontal-only summaries, full-list reading and zoom/pan toolbar bounds. The rapid-tap case pauses the opening frame with Playwright's clock to ensure the native tap reaches the moving grip; the other motion cases run in real time. The old landscape test now checks readable full details instead of requiring vertical carousel scrolling.

Completed validation:

| Check | Result |
| --- | --- |
| Unit suites | All 71 passed, including 38 snap-math cases |
| Typecheck | Passed on final source |
| Lint | No errors; five existing warnings in `swap.test.ts`. Final changed-file checks also passed |
| Production build | Passed; application source hashes match the tested isolated build |
| Full mock browser run | 155 passed, two failures investigated below, one optional Firebase case skipped |
| Unchanged mode-switch rerun | Passed |
| Final production UI run | All 22 passed: ten gesture/zoom cases plus twelve existing mobile/desktop cases |
| Visual review | Six final mobile/desktop screenshots inspected; small-screen content and 2× zoom bounds also checked |

The full run's overscroll test passed its 1px continuity assertion but then released below the drag threshold, correctly triggering the newly supported tap action. The test now continues a real drag after its 1px measurement; its original 2px continuity tolerance remains. The other failure stopped at a disabled landing submit button before creating an itinerary; the exact same mode-switch test passed on rerun without changes. No application assertion was loosened. The final UI run includes both the corrected overscroll case and the subsequently added 2× zoom regression.

The full scenario suite uses a mock development server because its time/disruption cases require development controls. An initial attempt against production was stopped when those absent controls caused timeouts. Production build and final UI verification ran separately with the default production visibility of those controls. All verification used isolated copies with fixture data and blocked browser provider requests; no credentials were copied.

Final screenshots: [peek](verification/mobile-peek-390.png), [halfway](verification/mobile-half-390.png), [full itinerary](verification/mobile-full-390.png). These show the deterministic map fallback, not live Google Maps.

## Remaining device check

The local tests establish the controlled application fixes. They do not establish physical iPhone Chrome frame rate or reproduce the owner's exact keyboard/browser-bar trigger with a live Google map. Desktop WebKit diagnostic events are synthetic and are not native iOS touch validation. Check the branch on the owner's phone before calling its device-specific feel verified.

The original findings and baseline evidence remain in [the investigation](README.md).
