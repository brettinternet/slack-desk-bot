import { startApplication, type RunningApplication, type ShutdownStage } from "./application.ts";
import { loadConfig } from "./config.ts";

export const SHUTDOWN_TIMEOUT_MS = 15_000;

interface ShutdownOptions {
  timeoutMs?: number;
  exit?: (code: number) => void;
  logError?: (message: string) => void;
}

export async function shutdownApplication(
  application: RunningApplication,
  options: ShutdownOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? process.exit;
  const logError = options.logError ?? console.error;
  let stage: ShutdownStage = "health_server";
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const outcome = await Promise.race([
    application
      .stop((nextStage) => {
        stage = nextStage;
      })
      .then(
        () => ({ type: "stopped" as const }),
        (error: unknown) => ({ type: "failed" as const, error }),
      ),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ type: "timed_out" }), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (outcome.type === "timed_out") {
    logError(`SlackDeskBot shutdown timed out during ${stage} after ${timeoutMs} ms`);
    exit(1);
    return;
  }
  if (outcome.type === "failed") {
    logError(
      `SlackDeskBot shutdown failed during ${stage}: ${
        outcome.error instanceof Error ? outcome.error.message : "unknown shutdown error"
      }`,
    );
    exit(1);
    return;
  }
  exit(0);
}

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RunningApplication> {
  return startApplication(loadConfig(environment));
}

if (import.meta.main) {
  try {
    const application = await main();
    let shutdownStarted = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        void shutdownApplication(application);
      });
    }
  } catch (error) {
    console.error(
      `SlackDeskBot failed to start: ${error instanceof Error ? error.message : "unknown startup error"}`,
    );
    process.exitCode = 1;
  }
}
