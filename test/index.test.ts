import { describe, expect, mock, test } from "bun:test";
import type { RunningApplication, ShutdownStage } from "../src/application.ts";
import { shutdownApplication } from "../src/index.ts";

function application(
  stop: (onStage?: (stage: ShutdownStage) => void) => Promise<void>,
): RunningApplication {
  return { healthPort: 0, stop };
}

describe("process shutdown", () => {
  test("exits nonzero within the deadline and reports a stalling stage", async () => {
    const exit = mock((_code: number) => {});
    const logError = mock((_message: string) => {});
    const startedAt = performance.now();

    await shutdownApplication(
      application(async (onStage) => {
        onStage?.("local_control");
        await new Promise(() => {});
      }),
      { timeoutMs: 20, exit, logError },
    );

    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logError).toHaveBeenCalledWith(
      "SlackDeskBot shutdown timed out during local_control after 20 ms",
    );
  });

  test("exits zero after graceful shutdown", async () => {
    const exit = mock((_code: number) => {});
    const logError = mock((_message: string) => {});

    await shutdownApplication(
      application(async () => {}),
      { timeoutMs: 20, exit, logError },
    );

    expect(exit).toHaveBeenCalledWith(0);
    expect(logError).not.toHaveBeenCalled();
  });

  test("exits nonzero and reports a shutdown failure", async () => {
    const exit = mock((_code: number) => {});
    const logError = mock((_message: string) => {});

    await shutdownApplication(
      application(async (onStage) => {
        onStage?.("slack");
        throw new Error("disconnect failed");
      }),
      { timeoutMs: 20, exit, logError },
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(logError).toHaveBeenCalledWith(
      "SlackDeskBot shutdown failed during slack: disconnect failed",
    );
  });
});
