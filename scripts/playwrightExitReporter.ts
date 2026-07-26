import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
} from "@playwright/test/reporter";

/**
 * Windows can retain a Playwright CLI event-loop handle after the reporter
 * has emitted the complete summary. The npm mock harness gives its runner
 * an IPC channel; this final reporter sends the authoritative result so the
 * harness can close that exact runner tree. Direct invocations are unchanged.
 */
export default class PlaywrightExitReporter implements Reporter {
  private total = 0;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.total = suite.allTests().length;
  }

  onEnd(result: FullResult): void {
    console.log(`\nHarness result: ${this.total} tests ${result.status}.`);
    if (typeof process.send === "function") {
      process.send({
        type: "itinerary-playwright-complete",
        status: result.status,
      });
    }
  }
}
