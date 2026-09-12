import { startApplication, type RunningApplication } from "./application.ts";
import { loadConfig } from "./config.ts";

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RunningApplication> {
  return startApplication(loadConfig(environment));
}

if (import.meta.main) {
  try {
    const application = await main();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void application.stop().finally(() => process.exit());
      });
    }
  } catch (error) {
    console.error(
      `SlackDeskBot failed to start: ${error instanceof Error ? error.message : "unknown startup error"}`,
    );
    process.exitCode = 1;
  }
}
