import { notFound } from "next/navigation";
import MapsHarness from "./MapsHarness";

/**
 * Browser-only resilience harness. It is available to the deterministic
 * mock server and resolves as a normal 404 in every non-mock environment.
 */
export default function MapsHarnessPage() {
  if (process.env.E2E_MOCK !== "1") notFound();
  return <MapsHarness />;
}
