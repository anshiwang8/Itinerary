/**
 * Development controls are available automatically outside production.
 * A production build exposes them only through an explicit, exact opt-in.
 */
export function shouldShowDevControls(
  nodeEnv: string | undefined,
  publicFlag: string | undefined
): boolean {
  return nodeEnv !== "production" || publicFlag === "true";
}
