// The live-position tracker's state machine, proven without a browser, a
// real clock, or a real GPS. Every browser dependency is injected, so each
// case drives visibility, timers, fixes and errors by hand and asserts the
// exact resulting state.
//
// The three things this suite is really here to pin:
//   1. The tracker NEVER interpolates. Between two fixes it holds exactly
//      the last one the device reported and does not move it.
//   2. Staleness is detected, both ways: the tab backgrounding (event) and
//      the stream just going silent while visible (heartbeat).
//   3. A backgrounded tab gets a brand-NEW watch on return, never a
//      resumed one, and every failure mode lands somewhere honest without
//      throwing.
import assert from "node:assert";
import {
  createLiveTracker,
  DEFAULT_LIVE_TRACKING_CONFIG,
  type GeolocationLike,
  type LiveTrackingConfig,
  type LiveTrackingState,
} from "./liveTracking";

type Case = [string, () => void];

interface FixInput {
  lat?: number;
  lng?: number;
  accuracy?: number;
  deviceTimestamp?: number;
}

function makeHarness(configPatch: Partial<LiveTrackingConfig> = {}, startHidden = false) {
  let nowMs = 1_700_000_000_000;
  let hidden = startHidden;
  let geoPresent = true;

  let visibilityListener: (() => void) | null = null;
  let heartbeatCb: (() => void) | null = null;
  let successCb: ((p: GeolocationPosition) => void) | null = null;
  let errorCb: ((e: GeolocationPositionError) => void) | null = null;
  let oneShotSuccessCb: ((p: GeolocationPosition) => void) | null = null;
  let oneShotErrorCb: ((e: GeolocationPositionError) => void) | null = null;
  const oneShotOptions: PositionOptions[] = [];

  const watchIds: number[] = [];
  const clearedIds: number[] = [];
  let nextWatchId = 1;

  const geolocation: GeolocationLike = {
    watchPosition(success, error) {
      const id = nextWatchId++;
      watchIds.push(id);
      successCb = success;
      errorCb = error;
      return id;
    },
    clearWatch(id: number) {
      clearedIds.push(id);
    },
    getCurrentPosition(success, error, options) {
      oneShotOptions.push(options ?? {});
      oneShotSuccessCb = success;
      oneShotErrorCb = error;
    },
  };

  const states: LiveTrackingState[] = [];
  const tracker = createLiveTracker(
    (s) => states.push(s),
    {
      getGeolocation: () => (geoPresent ? geolocation : null),
      addVisibilityListener: (listener) => {
        visibilityListener = listener;
        return () => {
          visibilityListener = null;
        };
      },
      isHidden: () => hidden,
      setHeartbeat: (cb) => {
        heartbeatCb = cb;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearHeartbeat: () => {
        heartbeatCb = null;
      },
      now: () => nowMs,
    },
    { ...DEFAULT_LIVE_TRACKING_CONFIG, ...configPatch }
  );

  return {
    tracker,
    states,
    get last(): LiveTrackingState {
      return states[states.length - 1];
    },
    get nowMs() {
      return nowMs;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    setHidden(value: boolean) {
      hidden = value;
      visibilityListener?.();
    },
    fireHeartbeat() {
      heartbeatCb?.();
    },
    emitFix(input: FixInput = {}) {
      successCb?.({
        coords: {
          latitude: input.lat ?? 43.6532,
          longitude: input.lng ?? -79.3832,
          accuracy: input.accuracy ?? 18,
        },
        timestamp: input.deviceTimestamp ?? nowMs,
      } as GeolocationPosition);
    },
    emitError(code: number) {
      errorCb?.({ code, message: "test geolocation error" } as GeolocationPositionError);
    },
    emitOneShotFix(input: FixInput = {}) {
      oneShotSuccessCb?.({
        coords: {
          latitude: input.lat ?? 43.6532,
          longitude: input.lng ?? -79.3832,
          accuracy: input.accuracy ?? 18,
        },
        timestamp: input.deviceTimestamp ?? nowMs,
      } as GeolocationPosition);
    },
    emitOneShotError(code: number) {
      oneShotErrorCb?.({
        code,
        message: "test one-shot geolocation error",
      } as GeolocationPositionError);
    },
    get oneShotCount() {
      return oneShotOptions.length;
    },
    get lastOneShotOptions(): PositionOptions {
      return oneShotOptions[oneShotOptions.length - 1];
    },
    removeGeolocation() {
      geoPresent = false;
    },
    get watchCount() {
      return watchIds.length;
    },
    get clearedIds() {
      return clearedIds.slice();
    },
    get heartbeatRunning() {
      return heartbeatCb !== null;
    },
    get visibilityListenerAttached() {
      return visibilityListener !== null;
    },
  };
}

const STALE = DEFAULT_LIVE_TRACKING_CONFIG.stalenessMs;

const cases: Case[] = [
  [
    "initial state is 'off' and nothing is wired up until start()",
    () => {
      const h = makeHarness();
      assert.strictEqual(h.tracker.getState().status, "off");
      assert.strictEqual(h.tracker.getState().position, null);
      assert.strictEqual(h.heartbeatRunning, false);
      assert.strictEqual(h.visibilityListenerAttached, false);
      assert.strictEqual(h.states.length, 0);
    },
  ],
  [
    "start() -> 'requesting', attaches the heartbeat + visibility listener, opens one watch",
    () => {
      const h = makeHarness();
      h.tracker.start();
      assert.strictEqual(h.last.status, "requesting");
      assert.strictEqual(h.heartbeatRunning, true);
      assert.strictEqual(h.visibilityListenerAttached, true);
      assert.strictEqual(h.watchCount, 1);
    },
  ],
  [
    "start() is idempotent: a second call opens no second watch",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.tracker.start();
      assert.strictEqual(h.watchCount, 1);
    },
  ],
  [
    "first real fix -> 'live' with the exact device values, lastUpdatedAt on our clock",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.advance(4000);
      const deviceTs = h.nowMs - 1200;
      h.emitFix({ lat: 43.11, lng: -79.22, accuracy: 9, deviceTimestamp: deviceTs });
      assert.strictEqual(h.last.status, "live");
      assert.deepStrictEqual(h.last.position, {
        lat: 43.11,
        lng: -79.22,
        accuracyM: 9,
        deviceTimestamp: deviceTs,
      });
      assert.strictEqual(h.last.lastUpdatedAt, h.nowMs);
      assert.strictEqual(h.last.errorKind, null);
      assert.strictEqual(h.last.staleReason, null);
    },
  ],
  [
    "NEVER interpolates: between two fixes the position is exactly the last one reported",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ lat: 43.0, lng: -79.0 });
      h.advance(20_000);
      h.emitFix({ lat: 43.5, lng: -79.5 });
      assert.deepStrictEqual(
        { lat: h.last.position!.lat, lng: h.last.position!.lng },
        { lat: 43.5, lng: -79.5 },
        "the second fix's exact coordinates, not a blend of the two"
      );
      const at = h.last.lastUpdatedAt;
      // 10s pass with NO new fix. The device could be anywhere; the module
      // must not advance the dot or the timestamp.
      h.advance(10_000);
      const snapshot = h.tracker.getState();
      assert.deepStrictEqual(
        { lat: snapshot.position!.lat, lng: snapshot.position!.lng },
        { lat: 43.5, lng: -79.5 },
        "still exactly the last real fix, never extrapolated forward"
      );
      assert.strictEqual(snapshot.lastUpdatedAt, at, "and the receipt time is unchanged");
    },
  ],
  [
    "staleness heartbeat: 'live' -> 'stale' once now passes the threshold, fix retained",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ lat: 1, lng: 2 });
      const at = h.last.lastUpdatedAt;
      h.advance(STALE + 1000);
      h.fireHeartbeat();
      assert.strictEqual(h.last.status, "stale");
      assert.strictEqual(h.last.staleReason, "no_recent_fix");
      assert.deepStrictEqual(
        { lat: h.last.position!.lat, lng: h.last.position!.lng },
        { lat: 1, lng: 2 },
        "the last known fix is kept, not deleted"
      );
      assert.strictEqual(h.last.lastUpdatedAt, at, "and its timestamp is preserved for 'last known ...'");
    },
  ],
  [
    "heartbeat before the threshold does nothing",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix();
      const stateCount = h.states.length;
      h.advance(STALE - 5000);
      h.fireHeartbeat();
      assert.strictEqual(h.last.status, "live");
      assert.strictEqual(h.states.length, stateCount, "no transition emitted");
    },
  ],
  [
    "'stale' -> 'live' again when the next real fix arrives",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix();
      h.advance(STALE + 1000);
      h.fireHeartbeat();
      assert.strictEqual(h.last.status, "stale");
      h.advance(2000);
      h.emitFix({ lat: 5, lng: 6 });
      assert.strictEqual(h.last.status, "live");
      assert.strictEqual(h.last.staleReason, null);
      assert.strictEqual(h.last.errorKind, null);
      assert.strictEqual(h.last.lastUpdatedAt, h.nowMs);
    },
  ],
  [
    "tab hidden -> 'stale' (backgrounded) and the watch is explicitly cleared",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ lat: 9, lng: 9 });
      h.setHidden(true);
      assert.strictEqual(h.last.status, "stale");
      assert.strictEqual(h.last.staleReason, "backgrounded");
      assert.deepStrictEqual(h.clearedIds, [1], "the running watch was cleared, not left to rot");
      assert.deepStrictEqual(
        { lat: h.last.position!.lat, lng: h.last.position!.lng },
        { lat: 9, lng: 9 },
        "last known position retained through the pause"
      );
    },
  ],
  [
    "tab visible again -> a NEW watch (not a resume), then 'live' on the next fix",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix();
      h.setHidden(true);
      h.setHidden(false);
      assert.strictEqual(h.last.status, "requesting", "not 'live' until a real fix actually lands");
      assert.strictEqual(h.watchCount, 2, "a second, brand-new watchPosition call");
      assert.deepStrictEqual(h.clearedIds, [1], "only the first watch was ever cleared");
      h.emitFix({ lat: 7, lng: 8 });
      assert.strictEqual(h.last.status, "live");
      assert.strictEqual(h.last.lastUpdatedAt, h.nowMs);
    },
  ],
  [
    "backgrounded before the first fix -> 'requesting' (nothing to show), watch cleared",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.setHidden(true);
      assert.strictEqual(h.last.status, "requesting");
      assert.strictEqual(h.last.staleReason, null);
      assert.deepStrictEqual(h.clearedIds, [1]);
      assert.strictEqual(h.last.position, null);
    },
  ],
  [
    "start() while the tab is already hidden -> 'requesting', NO watch until it becomes visible",
    () => {
      const h = makeHarness({}, /* startHidden */ true);
      h.tracker.start();
      assert.strictEqual(h.last.status, "requesting");
      assert.strictEqual(h.watchCount, 0, "do not call watchPosition into a hidden tab");
      assert.strictEqual(h.heartbeatRunning, true);
      assert.strictEqual(h.visibilityListenerAttached, true);
      h.setHidden(false);
      assert.strictEqual(h.watchCount, 1, "the watch opens when the tab comes to the foreground");
    },
  ],
  [
    "heartbeat while 'stale'/backgrounded never overwrites the reason or throws",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix();
      h.setHidden(true);
      assert.strictEqual(h.last.staleReason, "backgrounded");
      h.advance(STALE * 3);
      h.fireHeartbeat();
      h.fireHeartbeat();
      assert.strictEqual(h.last.status, "stale");
      assert.strictEqual(h.last.staleReason, "backgrounded", "heartbeat only acts on a 'live' fix");
    },
  ],
  [
    "permission DENIED (code 1) -> 'denied', full teardown, position cleared, no throw",
    () => {
      const h = makeHarness();
      h.tracker.start();
      assert.doesNotThrow(() => h.emitError(1));
      assert.strictEqual(h.last.status, "denied");
      assert.strictEqual(h.last.errorKind, "denied");
      assert.strictEqual(h.last.position, null);
      assert.strictEqual(h.heartbeatRunning, false, "heartbeat stopped");
      assert.strictEqual(h.visibilityListenerAttached, false, "visibility listener detached");
      assert.deepStrictEqual(h.clearedIds, [1], "the watch was cleared");
    },
  ],
  [
    "DENIED after a good fix still tears down and clears the retained position",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ lat: 2, lng: 3 });
      h.emitError(1);
      assert.strictEqual(h.last.status, "denied");
      assert.strictEqual(h.last.position, null);
    },
  ],
  [
    "POSITION_UNAVAILABLE (code 2) with no prior fix -> 'unavailable', watch left running, recovers on a fix",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitError(2);
      assert.strictEqual(h.last.status, "unavailable");
      assert.strictEqual(h.last.errorKind, "unavailable");
      assert.deepStrictEqual(h.clearedIds, [], "the watch keeps trying");
      assert.strictEqual(h.heartbeatRunning, true);
      h.emitFix({ lat: 4, lng: 4 });
      assert.strictEqual(h.last.status, "live");
    },
  ],
  [
    "TIMEOUT (code 3) with no prior fix -> 'unavailable' with errorKind 'timeout'",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitError(3);
      assert.strictEqual(h.last.status, "unavailable");
      assert.strictEqual(h.last.errorKind, "timeout");
    },
  ],
  [
    "TIMEOUT (code 3) after a good fix -> 'stale', fix retained, errorKind 'timeout'",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ lat: 1, lng: 1 });
      h.emitError(3);
      assert.strictEqual(h.last.status, "stale");
      assert.strictEqual(h.last.errorKind, "timeout");
      assert.strictEqual(h.last.staleReason, "no_recent_fix");
      assert.deepStrictEqual(
        { lat: h.last.position!.lat, lng: h.last.position!.lng },
        { lat: 1, lng: 1 }
      );
    },
  ],
  [
    "no geolocation API at all -> start() rests at 'unavailable', wires up nothing, does not throw",
    () => {
      const h = makeHarness();
      h.removeGeolocation();
      assert.doesNotThrow(() => h.tracker.start());
      assert.strictEqual(h.last.status, "unavailable");
      assert.strictEqual(h.last.errorKind, "unavailable");
      assert.strictEqual(h.heartbeatRunning, false);
      assert.strictEqual(h.visibilityListenerAttached, false);
      assert.strictEqual(h.watchCount, 0);
    },
  ],
  [
    "stop() -> 'off' with everything torn down and the watch cleared",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix();
      h.tracker.stop();
      assert.strictEqual(h.last.status, "off");
      assert.strictEqual(h.last.position, null);
      assert.strictEqual(h.last.lastUpdatedAt, null);
      assert.strictEqual(h.heartbeatRunning, false);
      assert.strictEqual(h.visibilityListenerAttached, false);
      assert.deepStrictEqual(h.clearedIds, [1]);
    },
  ],
  [
    "stop() before start() (and a double stop()) is a silent no-op",
    () => {
      const h = makeHarness();
      assert.doesNotThrow(() => h.tracker.stop());
      assert.doesNotThrow(() => h.tracker.stop());
      assert.strictEqual(h.tracker.getState().status, "off");
      assert.strictEqual(h.states.length, 0, "no transition emitted for a no-op stop");
    },
  ],
  [
    "a fix that lands AFTER stop() is ignored (post-teardown race)",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.tracker.stop();
      const countAfterStop = h.states.length;
      h.emitFix({ lat: 50, lng: 50 });
      assert.strictEqual(h.tracker.getState().status, "off");
      assert.strictEqual(h.states.length, countAfterStop, "the late callback produced no state change");
    },
  ],
  [
    "start() after a DENIED can retry (the module never permanently locks itself out)",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitError(1);
      assert.strictEqual(h.last.status, "denied");
      h.tracker.start();
      assert.strictEqual(h.last.status, "requesting");
      assert.strictEqual(h.watchCount, 2, "a fresh watch on the retry");
      assert.strictEqual(h.heartbeatRunning, true);
    },
  ],

  // ── Arrival sanity guard: a fix that is ALREADY stale when it lands ──
  [
    "a fix already older than the staleness window ON ARRIVAL -> 'stale' on its FIRST transition, no heartbeat tick",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.advance(3_000);
      const oldTs = h.nowMs - (STALE + 30_000);
      const before = h.states.length;
      // No h.fireHeartbeat() anywhere in this case.
      h.emitFix({ lat: 12, lng: 34, deviceTimestamp: oldTs });

      const firstTransition = h.states[before];
      assert.strictEqual(
        firstTransition.status,
        "stale",
        "the fix's OWN transition is stale — never 'live for one heartbeat then corrected'"
      );
      assert.strictEqual(firstTransition.staleReason, "stale_on_arrival");
      assert.strictEqual(firstTransition.fixAgeAtReceiptMs, STALE + 30_000);
      assert.strictEqual(firstTransition.lastUpdatedAt, h.nowMs, "receipt time is still our clock");
      // Nothing this fix ever produces is 'live'.
      for (const s of h.states.slice(before)) {
        assert.notStrictEqual(s.status, "live", "no state after a stale-on-arrival fix is 'live'");
      }
      assert.deepStrictEqual(
        { lat: firstTransition.position!.lat, lng: firstTransition.position!.lng },
        { lat: 12, lng: 34 },
        "the fix itself is retained, exactly as reported"
      );
      assert.strictEqual(
        firstTransition.position!.deviceTimestamp,
        oldTs,
        "deviceTimestamp is NEVER rewritten — the guard derives a separate age"
      );
    },
  ],
  [
    "clock skew: a fix with a FUTURE deviceTimestamp -> age 'unknown' (null), NOT treated as extra-fresh",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ deviceTimestamp: h.nowMs + 60_000 });
      assert.strictEqual(h.last.status, "live", "negative raw age never forces stale");
      assert.strictEqual(
        h.last.fixAgeAtReceiptMs,
        null,
        "unknowable age is null, not clamped to 0 and read as fresh"
      );
      assert.strictEqual(h.last.staleReason, null);
      assert.strictEqual(h.oneShotCount, 0, "clock skew is not a stale-on-arrival event");
    },
  ],
  [
    "a fresh fix is unaffected: normal 'live', small real fixAgeAtReceiptMs, no escalation",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.advance(5_000);
      h.emitFix({ deviceTimestamp: h.nowMs - 1_200 });
      assert.strictEqual(h.last.status, "live");
      assert.strictEqual(h.last.fixAgeAtReceiptMs, 1_200);
      assert.strictEqual(h.last.staleReason, null);
      assert.strictEqual(h.oneShotCount, 0, "a healthy first fix triggers no probe");
    },
  ],

  // ── The bounded escalation ──────────────────────────────────────────
  [
    "stale-on-arrival FIRST fix -> exactly ONE forced-fresh probe; a fresh probe result -> 'live'",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ lat: 1, lng: 1, deviceTimestamp: h.nowMs - (STALE + 5_000) });
      assert.strictEqual(h.oneShotCount, 1, "one probe fired");
      assert.strictEqual(h.last.status, "requesting", "visibly attempting while the probe runs");
      assert.strictEqual(h.lastOneShotOptions.maximumAge, 0, "forced fresh");
      assert.strictEqual(h.lastOneShotOptions.enableHighAccuracy, true);
      assert.strictEqual(
        h.lastOneShotOptions.timeout,
        DEFAULT_LIVE_TRACKING_CONFIG.escalationTimeoutMs,
        "bounded by the escalation timeout, not the normal one"
      );
      h.advance(2_000);
      h.emitOneShotFix({ lat: 2, lng: 2, deviceTimestamp: h.nowMs - 500 });
      assert.strictEqual(h.last.status, "live", "a genuinely fresher fix recovers to live");
      assert.strictEqual(h.last.fixAgeAtReceiptMs, 500);
      assert.strictEqual(h.oneShotCount, 1, "the probe's own result never re-escalates");
    },
  ],
  [
    "PROVABLY BOUNDED: the probe ALSO returns stale -> settle on 'stale', never a second probe",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ lat: 1, lng: 1, deviceTimestamp: h.nowMs - (STALE + 5_000) });
      assert.strictEqual(h.oneShotCount, 1);
      h.emitOneShotFix({ lat: 9, lng: 9, deviceTimestamp: h.nowMs - (STALE + 4_000) });
      assert.strictEqual(h.last.status, "stale");
      assert.strictEqual(h.last.staleReason, "stale_on_arrival");
      assert.strictEqual(h.oneShotCount, 1, "one stale-on-arrival event -> at most one probe");
      // And a later stale watch fix still does not spin up another.
      h.advance(1_000);
      h.emitFix({ lat: 9, lng: 9, deviceTimestamp: h.nowMs - (STALE + 4_000) });
      assert.strictEqual(h.oneShotCount, 1, "still bounded");
    },
  ],
  [
    "the probe times out -> fall back to the retained stale fix, marked stale, no retry",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ lat: 7, lng: 7, deviceTimestamp: h.nowMs - (STALE + 5_000) });
      assert.strictEqual(h.last.status, "requesting");
      h.emitOneShotError(3); // TIMEOUT
      assert.strictEqual(h.last.status, "stale", "settles on the stale fix we already hold");
      assert.deepStrictEqual(
        { lat: h.last.position!.lat, lng: h.last.position!.lng },
        { lat: 7, lng: 7 }
      );
      assert.strictEqual(h.oneShotCount, 1, "timed out is a clean settle, not a re-try");
    },
  ],
  [
    "a LATER stale-on-arrival fix (not the first of the session) does NOT escalate",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ deviceTimestamp: h.nowMs - 1_000 }); // healthy first fix
      assert.strictEqual(h.last.status, "live");
      h.advance(20_000);
      h.emitFix({ deviceTimestamp: h.nowMs - (STALE + 10_000) }); // now a stale one
      assert.strictEqual(h.last.status, "stale");
      assert.strictEqual(h.last.staleReason, "stale_on_arrival");
      assert.strictEqual(h.oneShotCount, 0, "escalation is for the FIRST fix only");
    },
  ],
  [
    "escalation re-arms after a background/resume: a stale first fix on the NEW watch probes once",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ deviceTimestamp: h.nowMs - 1_000 }); // healthy, consumes the initial arm
      assert.strictEqual(h.oneShotCount, 0);
      h.setHidden(true);
      h.setHidden(false); // a brand-new watch
      assert.strictEqual(h.watchCount, 2);
      h.emitFix({ deviceTimestamp: h.nowMs - (STALE + 8_000) });
      assert.strictEqual(h.last.status, "requesting");
      assert.strictEqual(h.oneShotCount, 1, "the fresh watch session gets its own single probe");
    },
  ],
  [
    "an unanswered probe does not loop: no heartbeat resurrects it, it rests until a real result",
    () => {
      const h = makeHarness();
      h.tracker.start();
      h.emitFix({ deviceTimestamp: h.nowMs - (STALE + 5_000) });
      assert.strictEqual(h.oneShotCount, 1, "the single probe fired");
      // Nothing ever answers the probe (a browser that silently never calls
      // back). The heartbeat only acts on 'live', so it stays put — no
      // second probe, no spin.
      h.advance(STALE * 5);
      h.fireHeartbeat();
      h.fireHeartbeat();
      assert.strictEqual(h.last.status, "requesting");
      assert.strictEqual(h.oneShotCount, 1, "still exactly one probe, ever");
    },
  ],
];

function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error instanceof Error ? error.stack ?? error.message : error}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
