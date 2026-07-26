import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");
const nextCli = join(root, "node_modules", "next", "dist", "bin", "next");
const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const sharedEnv = {
  ...process.env,
  E2E_MOCK: "1",
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "e2e-invalid-browser-key",
};

let server: ChildProcess | null = null;
let cleaned = false;

function stopProcessTree(child: ChildProcess | null): void {
  const pid = child?.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    // The exact process was spawned above. /T is necessary because Next's
    // dev CLI owns a worker; it avoids the orphan that made Playwright hang
    // after every assertion had already passed.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000,
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The server may already have exited; cleanup is still complete.
  }
}

function stopServerTree(): void {
  if (cleaned) return;
  cleaned = true;
  stopProcessTree(server);
}

function onSignal(code: number): void {
  stopServerTree();
  process.exit(code);
}

process.once("SIGINT", () => onSignal(130));
process.once("SIGTERM", () => onSignal(143));

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server?.exitCode != null) {
      throw new Error(
        `The mock Next server exited before becoming ready (code ${server.exitCode}).`
      );
    }
    try {
      const response = await fetch(baseURL, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status >= 200) return;
    } catch {
      // Cold compilation is expected to refuse requests briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The mock Next server did not become ready on port ${port}.`);
}

function runPlaywright(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const runner = spawn(process.execPath, [playwrightCli, "test", ...args], {
      cwd: root,
      env: {
        ...sharedEnv,
        E2E_SERVER_PRESTARTED: "1",
        E2E_FORCE_EXIT_ON_END: "1",
      },
      // stopProcessTree uses a negative pid on Unix, so the runner must own
      // its process group there. Windows keeps detached=false and continues
      // to use taskkill against the exact spawned pid.
      detached: process.platform !== "win32",
      // Do not let browser/worker descendants inherit the outer shell's
      // output handles. Forward the runner's pipes explicitly instead.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    runner.stdout?.pipe(process.stdout);
    runner.stderr?.pipe(process.stderr);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      runner.stdout?.unpipe(process.stdout);
      runner.stderr?.unpipe(process.stderr);
      runner.stdout?.destroy();
      runner.stderr?.destroy();
      resolve(code);
    };
    runner.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    runner.on("message", (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "itinerary-playwright-complete" &&
        "status" in message
      ) {
        const code = message.status === "passed" ? 0 : 1;
        stopProcessTree(runner);
        finish(code);
      }
    });
    runner.once("exit", (code, signal) => {
      if (settled) return;
      if (signal) {
        reject(new Error(`Playwright exited from signal ${signal}.`));
        return;
      }
      finish(code ?? 1);
    });
  });
}

async function main(): Promise<number> {
  server = spawn(process.execPath, [nextCli, "dev", "-p", String(port)], {
    cwd: root,
    env: sharedEnv,
    stdio: "ignore",
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  try {
    await waitForServer();
    return await runPlaywright(process.argv.slice(2));
  } finally {
    stopServerTree();
  }
}

void main().then(
  (exitCode) => process.exit(exitCode),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    stopServerTree();
    process.exit(1);
  }
);
