// Runner configuration: where to point, how fast to move, what it costs.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const OUTPUT_DIR = path.join(HARNESS_DIR, "output");
export const AUTH_STATE_PATH = path.join(HARNESS_DIR, "output", "signed-in-state.json");

/**
 * The deployed app, as documented in README.md ("👉 https://itinerary-six.vercel.app/")
 * and CLAUDE.md's "Deployed and live at itinerary-six.vercel.app".
 *
 * Nothing in the repo defines an env var for this today, so this constant is
 * the documented URL rather than a guess, and `AGENT_TEST_BASE_URL` overrides
 * it. A LOCAL url is refused unless `--allow-local` is passed explicitly: the
 * whole point of this harness is the real deployment, and silently testing
 * localhost would produce a report that looks real and proves nothing.
 */
export const DEFAULT_BASE_URL = "https://itinerary-six.vercel.app";

export interface RunOptions {
  baseURL: string;
  confirmed: boolean;
  allowLocal: boolean;
  personaFilter: string[] | null;
  /** Wall-clock ceiling per persona, milliseconds. */
  personaTimeoutMs: number;
  /** Divides real-world travel speed. 1 = true walking/driving pace. */
  speedMultiplier: number;
  /** Never spend longer than this crawling one leg, whatever its length. */
  maxLegTravelMs: number;
  /** Seconds between simulated position updates. */
  fixIntervalMs: number;
  headed: boolean;
  keepOpenOnFailure: boolean;
}

export const DEFAULTS = {
  // Generous because a persona that tests arrival has to wait out the plan's
  // own home leg before its first stop is underway, and the dwell that
  // follows is real time by necessity.
  personaTimeoutMs: 22 * 60_000,
  speedMultiplier: 20,
  maxLegTravelMs: 90_000,
  // Comfortably under the app's own 45s staleness threshold, so an on-route
  // persona never reads as "paused" purely because of harness pacing.
  fixIntervalMs: 4_000,
} as const;

/** True walking / driving ground speeds, before `speedMultiplier`. */
export const PACE_METERS_PER_SECOND = {
  walk: 1.4, // ~5 km/h
  drive: 9.7, // ~35 km/h, city driving
  transit: 8.3, // ~30 km/h door-to-door average; a per-leg figure overrides it
} as const;

/**
 * COST MODEL — rough, and deliberately labelled as such.
 *
 * These are list prices for the SKUs this app's pipeline uses, per call.
 * They are estimates for a warning message, not an invoice: actual spend
 * depends on the plan's shape (how many activities, whether a recovery
 * widen runs, how many legs), on OpenRouter routing, and on whatever volume
 * discounts the account has. The point is to stop an accidental 200-persona
 * run, not to bill anyone.
 */
export const COST_PER_CALL_USD = {
  /** Places Text Search, Pro SKU with the app's full field mask. */
  placesTextSearch: 0.032,
  /** Routes computeRoutes, transit/driving with steps. */
  routes: 0.01,
  /** Geocoding API. */
  geocode: 0.005,
  /** Google Weather hourly forecast. */
  weather: 0.006,
  /** Maps JavaScript dynamic map load. */
  mapLoad: 0.007,
  /** One OpenRouter completion (planner / select / swap), per CLAUDE.md's
   *  own "~$0.002 per planner call" figure, rounded up for the select and
   *  swap calls that ride the same chain. */
  model: 0.003,
} as const;

/** What one persona's plan-plus-edits run costs, roughly. */
export function estimatePersonaCostUSD(actionCounts: {
  plans: number;
  swaps: number;
  removes: number;
  modeSwitches: number;
  pageLoads: number;
}): number {
  const c = COST_PER_CALL_USD;
  const perPlan =
    2 * c.geocode + // city + starting address
    c.weather +
    4 * c.placesTextSearch + // ~one per activity on a 3-4 stop day
    2 * c.model + // planner + select
    4 * c.routes; // home leg + inter-stop legs, both modes probed on drive
  const perSwap = c.model + 2 * c.placesTextSearch + 3 * c.routes;
  const perRemove = 3 * c.routes;
  const perModeSwitch = 4 * c.routes;
  return (
    actionCounts.plans * perPlan +
    actionCounts.swaps * perSwap +
    actionCounts.removes * perRemove +
    actionCounts.modeSwitches * perModeSwitch +
    actionCounts.pageLoads * c.mapLoad
  );
}

export function parseArgs(argv: string[]): RunOptions {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string): string | null => {
    const prefixed = argv.find((a) => a.startsWith(`--${name}=`));
    if (prefixed) return prefixed.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")
      ? argv[index + 1]
      : null;
  };

  const only = value("only");
  const speed = Number(value("speed") ?? DEFAULTS.speedMultiplier);
  const timeoutMinutes = Number(value("timeout") ?? DEFAULTS.personaTimeoutMs / 60_000);

  return {
    baseURL: (process.env.AGENT_TEST_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    confirmed: flag("confirm"),
    allowLocal: flag("allow-local"),
    personaFilter: only ? only.split(",").map((s) => s.trim()).filter(Boolean) : null,
    personaTimeoutMs: Math.max(60_000, timeoutMinutes * 60_000),
    speedMultiplier: Number.isFinite(speed) && speed > 0 ? speed : DEFAULTS.speedMultiplier,
    maxLegTravelMs: Number(value("max-leg-ms") ?? DEFAULTS.maxLegTravelMs),
    fixIntervalMs: Number(value("fix-interval-ms") ?? DEFAULTS.fixIntervalMs),
    headed: flag("headed"),
    keepOpenOnFailure: flag("keep-open"),
  };
}

export function isLocalURL(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url);
}
