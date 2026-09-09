# Mobile itinerary panel investigation

Date: 2026-09-08  
Branch: `mobile-ui-fix`  
Baseline: `4211ea65efba8a23e8ab97308b5305733f6d7c4a` (deployed UI revision)  
Status: baseline investigation complete. Approved fixes are described in [Implementation and verification](IMPLEMENTATION.md). Source line numbers and measurements below refer to the baseline commit, not the revised working tree.

The owner reports Chrome on iPhone: the itinerary panel jumps, lags, snaps unexpectedly and sometimes feels stuck. The halfway view also scrolls vertically, and vertical movement over the map can hide the search bar. Desktop feels smooth.

The investigation reproduces several separate failure mechanisms. A geometry update abandons an active drag; the panel conceals its new content until the release animation finishes; and the halfway carousel explicitly permits vertical scrolling when its cards overflow. A controlled zoom-and-pan scenario also hides the toolbar without scrolling the document. The exact trigger for that last behavior on the owner's iPhone, and any device-specific frame-rate problem, remain unverified.

## Findings and priority

| Priority | Finding | Evidence level |
| --- | --- | --- |
| First | A viewport or control-size change cancels a held gesture and returns the sheet toward its previous snap | Reproduced with trusted Chromium touch input; binding behavior corroborated in desktop WebKit with synthetic events |
| First | Halfway cards have a second, vertical scroll direction; dragging their content does not move the sheet | Reproduced with trusted Chromium input at two viewport heights; explicit CSS behavior |
| First | Search controls can leave the visible screen when the zoomed visual viewport pans | Reproduced under controlled Chromium page zoom; actual iPhone trigger still open |
| Next | Peek-to-open movement exposes a blank surface before the cards appear after release | Reproduced in both browser engines |
| Next | Re-grabbing an animation changes background opacity instantly | Real CSS transition/computed-style measurements, with an atomic synthetic re-grab in both engines |
| Next | Fling selection and overscroll re-grab have discontinuities that can feel abrupt | Executed pure-code examples; not established as the owner's device trigger |
| Profile | Blur, clipping and repeated geometry measurement may add rendering cost | Code inspection only; physical-device profiling required |

## 1. Geometry changes abandon the finger

In [MobileItinerarySheet.tsx](../../app/MobileItinerarySheet.tsx), `measure()` reads viewport and control bounds (lines 101–120). Whenever the resulting geometry differs, it cancels pending work, clears the tracked touch ID and removes the dragging state (121–128). The layout effect then paints the old logical snap with the new geometry (156). Further moves from the same finger are ignored because its ID is no longer tracked.

Controlled reproduction, Chromium at 390 × 844:

1. Start at peek and hold the grip 130px higher.
2. While that finger remains down, increase the toolbar's measured height by 8px.
3. Move the same finger another 90px upward, then release.

The sheet's top moves from **586px to 681px** shortly after the size change, then to **714px** despite the finger moving farther upward. It settles at the original **716px peek position**. Dragging becomes false immediately after measurement. The browser delivered **zero `touchcancel` events**. The app itself discarded the gesture. See `geometryInterruption` in [Chromium measurements](evidence/chromium.json).

Reducing the viewport height by 40px during a held drag reproduces the same lost ownership. The [WebKit binding probe](evidence/webkit.json) corroborates both paths with synthetic touch events. These are controlled perturbations, not recordings of the iPhone's address bar or keyboard.

Real subscribers include window resize/orientation, visual-viewport resize/scroll, and resize observers on the toolbar, notices and map warning. Even small geometry differences take the cancellation path. The iPhone frequency of these events needs measurement, but the failure once geometry changes is confirmed.

**Recommended direction:** preserve gesture ownership and the painted position while updating its coordinate baseline and bounds. Coalesce geometry measurement per animation frame. Handle an actual touch cancellation separately from routine layout changes.

## 2. The halfway view really does scroll vertically

[mobileItinerary.css](../../app/mobileItinerary.css), lines 111–128, explicitly sets `overflow-y: auto` and `touch-action: pan-x pan-y` on the horizontal card track. This overrides the older horizontal-only rule in `globals.css`. The behavior was intentionally allowed for long cards and short screens, but it conflicts with the owner's expected halfway interaction.

The fixture's walking card is about **265px tall**: the narrow 40%-width travel card wraps the provider caution text. With 16px of track padding, content needs **281px**.

| Viewport | Track height | Content height | Measured vertical scroll after a swipe |
| --- | ---: | ---: | ---: |
| 390 × 844 | 276px | 281px | 5px |
| 390 × 740 | 229px | 281px | 52px |

The sheet remains at half while the card track scrolls. Document scroll remains zero. See `halfOverflow` and `halfVerticalSwipe` in [844px](evidence/chromium.json) and [740px](evidence/chromium-740.json) evidence.

There is an additional safe-area sizing issue: the body height already subtracts the bottom inset in `MobileItinerarySheet.tsx:233`; `.msheet__half` subtracts more usable room by adding that inset again as padding. A nonzero home-indicator inset can worsen overflow. The desktop probes have a zero safe-area inset, so that additional loss was identified in code, not measured on a notched phone.

Only the **44px grip** owns drag listeners (`MobileItinerarySheet.tsx:211–214`). The heading and cards have no gesture handoff to the sheet. A user pulling the card area therefore scrolls its contents or gets no sheet movement, which can feel like a stuck panel even when the grip works.

**Recommended direction:** agree on a compact halfway summary that fits its viewport, reserve the safe area once, and define which non-interactive header area can drag the sheet. Preserve readable provider cautions and access to complete travel facts. Keep native vertical scrolling in the full itinerary; simply clipping overflowing information or disabling touch panning on the whole sheet would create new problems.

## 3. The search bar can disappear without document scrolling

The normal-scale Chromium probe could not reproduce document scrolling: an upward map-area swipe left `window.scrollY`, the document's scroll position and visual-viewport offset at zero. Input focus/blur also left these unchanged in the desktop environment, which does not present the iPhone keyboard.

The controlled zoom probe did reproduce the reported appearance:

| Measurement | Before pan at 1.25× page scale | After upward map-area pan |
| --- | ---: | ---: |
| Document scroll | 0px | 0px |
| Visual viewport offset from page top | 0px | 138px |
| Toolbar top in layout coordinates | 12px | 12px |
| Toolbar top relative to visible screen, including scale | 15px | −157.5px |

The toolbar is then completely above the visible screen. See `zoomedMap` in [Chromium measurements](evidence/chromium.json) and the [captured screen](evidence/03-zoomed-map-pan.png).

The planned stage is fixed and locks document overflow in [uiLayout.css](../../app/uiLayout.css):52–64. Its toolbar retains an absolute top offset from [globals.css](../../app/globals.css):563. The sheet uses visual-viewport geometry, but the toolbar's CSS does not compensate for a panned visual viewport. Locking document scrolling therefore does not by itself keep the toolbar visible under page zoom. This distinction is consistent with Chrome's description of [layout versus visual viewports](https://developer.chrome.com/blog/visual-viewport-api/).

**Boundary:** the probe explicitly set page scale to 1.25; it did not discover what caused zoom on the owner's phone. Google Maps requests were blocked, so this does not characterize gestures on a loaded Google map. The actual map already specifies `gestureHandling: "greedy"` in `ItineraryMap.tsx:309`.

One hypothesis to check is focus-related page zoom: the landing input is 15px (`globals.css:266`) and the planned search input is 14px (`uiLayout.css:64`). The probe did not establish an iPhone focus-zoom trigger or a font-size threshold. Measure scale and offsets before and after focus, keyboard dismissal, planning and pinch zoom before prescribing a fix.

Chrome's iOS web layer wraps WKWebView/WebKit, according to the [Chromium iOS source documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/ios/web). Windows Chromium mobile emulation is therefore not a substitute for testing the owner's browser. Chrome also documents that [keyboard behavior can resize only the visual viewport](https://developer.chrome.com/blog/viewport-resize-behavior/), which these desktop probes do not reproduce.

**Recommended direction:** diagnose viewport offset, page scale and actual document scroll separately on the phone, then keep mobile controls reachable through keyboard and viewport changes while preserving user zoom accessibility.

## 4. Content appears only after the sheet finishes moving

`snap` controls the destination, while `contentSnap` controls which content is visible. `finish()` updates the latter after the transform transition, with a 320ms fallback timer (`MobileItinerarySheet.tsx:68–94`). The body stays hidden whenever `contentSnap` is peek (261).

In the 844px Chromium run, a slow **245px upward drag** moves the sheet top from **716px to 471px**, but its body is still hidden and has zero height. It remains hidden 100ms after release. Once settled, the heading and cards appear, with a roughly 276px body. The [held-drag image](evidence/01-peek-drag-held.png) and [settled image](evidence/02-half-settled.png) show that visible change. WebKit reproduces the same binding behavior.

This is the existing documented choice to defer content changes during motion, not evidence of slow fetching. It can feel like content lag or a pop even when the surface tracks the finger correctly.

**Recommended direction:** keep visible content available throughout expansion and contraction with stable layout and correct hidden/inert accessibility behavior. Choose the content transition deliberately rather than showing a blank growing surface.

## 5. Smaller motion discontinuities

**Background flash on re-grab.** The sheet transform uses a custom cubic curve (`mobileItinerary.css:13`); background opacity uses `ease` (`uiLayout.css:94`). Starting a new drag recomputes opacity from the painted sheet height (`MobileItinerarySheet.tsx:65, 172–177`), rather than retaining its currently painted opacity. In an atomic re-grab during a real CSS animation, Chromium opacity jumps **0.247 → 0.587**, while sheet top stays **272.57px**. WebKit shows **0.377 → 0.706**, also at an unchanged position. The event was synthetic to eliminate timing ambiguity; the animation and computed styles were real. See `regrab` in both measurement files. Synchronize the motion curves or preserve the painted visual state on interruption.

**Fling endpoint discontinuity.** The pure math picks the nearest snap and then advances one additional step for a fresh fling (`bottomSheet.ts:104–122`). With `resolveSheetHeights(844, 34, 144)` yielding peek 162, half 379.8 and full 700, an upward velocity of 0.8px/ms at height 270.9 chooses half; at 271.9 it chooses full. A 1px release difference changes the destination by 320.2px. At −0.8px/ms, heights 540.9 and 539.9 choose half and peek respectively. This is documented policy, not a frame-drop diagnosis. Reconsider it against the desired interaction and test boundary releases.

**Overscroll re-grab applies resistance twice.** A new gesture captures the already resisted painted height, then feeds it through `clampDragHeight` again on movement (`MobileItinerarySheet.tsx:161–172, 188–191`). With the same bounds, painted height 127 becomes 149.75 on a zero-delta calculation; 735 becomes 712.25. That is a 22.75px discontinuity without intended displacement. These are executed math examples, not recorded phone gestures; a small first move should be covered by a browser regression case.

**Release velocity samples one move segment.** The touch-end position is used for release height, but not for the terminal velocity (`MobileItinerarySheet.tsx:183–202`). A reversal between the last move event and release can retain the old fling direction if the sample is less than 100ms old. Its device frequency is unknown; test rapid reversals before changing the estimator.

## Performance suspects and things ruled out

- A 22px backdrop blur, clipping and shadows on a large moving surface can be profiling candidates. No physical iPhone frame-time or compositor trace was captured, so they are not confirmed causes of low frame rate.
- Geometry measurement creates, reads and removes a safe-area probe, interleaves layout reads with CSS writes, and can run from several uncoalesced event sources. Its cost should be profiled alongside the confirmed cancellation behavior.
- The sheet already paints transforms at most once per animation frame without a React state update on every touch move. Reintroducing that as a proposed fix would misdiagnose the current implementation.
- The old height transition in `globals.css` is overridden by the later transform transition. Dragging and reduced-motion overrides are active; there is no confirmed simultaneous height/transform transition conflict.
- Normal-scale document scroll containment passed in the local mock environment. This does not prove every iPhone keyboard, browser-toolbar or zoom state is contained.

## Why the earlier passing tests missed these issues

The existing [UI fixture tests](../../e2e/ui-fixture.spec.ts) switch sheet states primarily by clicking or using keyboard controls. Trusted touch swipes exercise map-pin containment and half/full content scrolling. The grip-specific multi-touch test starts and cancels a gesture but never moves the grip through a drag (`421–451`). There is no continuous grip touchmove, resize-during-drag or interrupted-settle assertion.

Tests can reach the correct final `data-state` while the animation in between still jumps. Optional review screenshots disable animations (`captureReview`, line 16), and the retained-scroll test explicitly arrests list inertia before switching views. Pure snap-math tests cannot prove browser event ordering or rendered continuity. Standard mock browser tests also block Google Maps network requests in [e2e/test.ts](../../e2e/test.ts).

## Reproduction package and limitations

[probe.mjs](probe.mjs) reproduces the controlled cases and writes JSON plus screenshots under the ignored `test-results/mobile-investigation/` directory (or `MOBILE_PROBE_OUTPUT` when specified). It is a diagnostic recorder, not a passing regression suite: process success means collection completed, not that mobile behavior is correct. The `evidence/` files preserve the baseline run.

Baseline execution used an isolated production build of the shipped application, serving the real UI and pipeline with `E2E_MOCK=1` fixture data on port 3100. No provider credentials were copied; the browser blocked all non-local HTTP(S). Chromium 149.0.7827.55 ran at 390 × 844 and 390 × 740, DPR 3, mobile/touch enabled. Desktop WebKit 26.5 ran at 390 × 844. Chromium drag/scroll inputs were trusted CDP touch events, except the explicitly synthetic atomic re-grab. WebKit used synthetic events and is binding/CSS corroboration only; it does not prove native iOS touch arbitration or inertia.

For a functional rerun from the repository root, install the declared dependencies and browser binaries, then start a mock server in one PowerShell terminal:

```powershell
npx playwright install chromium webkit
$env:E2E_MOCK = '1'
node node_modules/next/dist/bin/next dev -p 3100
```

Run the recorder in a second terminal:

```powershell
node investigations/mobile-ui-fix/probe.mjs chromium
node investigations/mobile-ui-fix/probe.mjs chromium 740
node investigations/mobile-ui-fix/probe.mjs webkit
```

Use a credential-free isolated production build for performance comparisons; the development rerun above proves behavior only. Server-side fixture mode is required: blocking browser requests alone does not mock server providers. Stop the mock server after collecting evidence.

The fixture can produce an adjustment banner that later disappears. That changes available full-sheet height between scenarios; the recorded bounds reflect the UI at each sample. Exact animation timestamps and intermediate pixels vary across machines. Safe-area insets, iOS keyboard/browser chrome, live Google Maps rendering and actual device frame rate were not reproduced.

## Proposed implementation and acceptance order

1. Preserve active drag ownership through geometry changes. Cover slow drags in both directions, a toolbar/notice resize, viewport resize, reversal, hold-before-release, real cancellation and re-grab during settling.
2. Resolve halfway content sizing and the intended drag area. Verify both axes at short portrait and landscape heights, long names/cautions, nonzero safe-area insets and larger text. Keep full-list reading and scroll retention usable.
3. Reproduce the disappearing toolbar on the owner's iPhone with its exact iOS/Chrome versions. Capture document scroll, visual-viewport height/offset/scale before planning, after focusing each search field, after keyboard dismissal and during map gestures. Compare scale 1 with user zoom; test with Google Maps loaded.
4. Make content and background changes continuous through motion. Cover interruption at several points, overscroll at both ends and reduced motion; then profile blur and measurement work on the phone if frame drops remain.
5. Run focused new browser regressions, the repository's required gates for the actual fix, and a desktop layout/hover check. Confirm mobile feel on the physical phone before declaring the reported glitch resolved.

No itinerary facts, scheduling, routing, provider data, desktop layout or production deployment were changed by this investigation. The next implementation should also update the relevant mobile interaction description in canonical `CLAUDE.md` when its deliberate policies change.
