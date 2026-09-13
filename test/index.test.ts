import { describe, expect, mock, test } from "bun:test";
import type { RunningApplication, ShutdownStage } from "../src/application.ts";
import type { StructuredLog } from "../src/log.ts";
import { shutdownApplication } from "../src/index.ts";

function application(
  stop: (onStage?: (stage: ShutdownStage) => void) => Promise<void>,
): RunningApplication {
  return { healthPort: 0, stop };
}

describe("process shutdown", () => {
  test("exits nonzero within the deadline and reports a stalling stage", async () => {
    const exit = mock((_code: number) => {});
    const records: StructuredLog[] = [];
    const startedAt = performance.now();

    await shutdownApplication(
      application(async (onStage) => {
        onStage?.("local_control");
        await new Promise(() => {});
      }),
      { timeoutMs: 20, exit, log: (record) => records.push(record) },
    );

    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(exit).toHaveBeenCalledWith(1);
    expect(records).toEqual([
      {
        event: "shutdown",
        outcome: "timeout",
        stage: "local_control",
        timeout_ms: 20,
      },
    ]);
  });

  test("exits zero after graceful shutdown", async () => {
    const exit = mock((_code: number) => {});
    const records: StructuredLog[] = [];

    await shutdownApplication(
      application(async () => {}),
      {
        timeoutMs: 20,
        exit,
        log: (record) => records.push(record),
      },
    );

    expect(exit).toHaveBeenCalledWith(0);
    expect(records).toEqual([{ event: "shutdown", outcome: "success", stage: "health_server" }]);
  });

  test("exits nonzero and reports a shutdown failure", async () => {
    const exit = mock((_code: number) => {});
    const records: StructuredLog[] = [];

    await shutdownApplication(
      application(async (onStage) => {
        onStage?.("slack");
        throw new Error("disconnect failed");
      }),
      { timeoutMs: 20, exit, log: (record) => records.push(record) },
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(records).toEqual([
      {
        event: "shutdown",
        outcome: "failure",
        stage: "slack",
        error_type: "Error",
        error_message: "disconnect failed",
      },
    ]);
  });
});
