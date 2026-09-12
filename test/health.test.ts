import { describe, expect, test } from "bun:test";
import { HealthState, SLACK_FAILURE_DEGRADED_THRESHOLD, startHealthServer } from "../src/health.ts";
import type { QueueSnapshot } from "../src/agent.ts";

const queue: QueueSnapshot = {
  active: 1,
  queued: 2,
  limits: { max_concurrent: 2, max_queued: 20 },
  saturated: false,
  backend_available: true,
};

describe("health server", () => {
  test("reports cheap process liveness separately from readiness", async () => {
    const state = new HealthState();
    state.setSlackConnection("connected");
    state.recordSuccessfulSlackOperation();
    const server = startHealthServer(0, { state, queue: () => queue });
    try {
      const liveness = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(liveness.status).toBe(200);
      expect(await liveness.json()).toMatchObject({ status: "ok", uptime_ms: expect.any(Number) });

      const readiness = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({
        status: "ready",
        slack: { connection: "connected", consecutive_delivery_failures: 0 },
        backend: { available: true },
        queue,
        last_successful_slack_operation_at: expect.any(String),
      });
    } finally {
      server.stop(true);
    }
  });

  test("serializes connection, disposal, and repeated delivery failure states", async () => {
    const state = new HealthState();
    state.setSlackConnection("connected");
    const server = startHealthServer(0, { state, queue: () => queue });
    try {
      expect(state.snapshot({ ...queue, saturated: true }).status).toBe("ready");

      state.setSlackConnection("reconnecting");
      let response = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "degraded" });

      state.setSlackConnection("connected");
      for (let index = 0; index < SLACK_FAILURE_DEGRADED_THRESHOLD; index++) {
        state.recordSlackDeliveryFailure();
      }
      response = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      expect((await response.json()).status).toBe("degraded");

      state.markBackendDisposed();
      response = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: "unhealthy",
        backend: { available: false },
      });
    } finally {
      server.stop(true);
    }
  });

  test("reports health after startup", async () => {
    const server = startHealthServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok" });
    } finally {
      server.stop(true);
    }
  });

  test("rejects unknown paths", async () => {
    const server = startHealthServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/unknown`);
      expect(response.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
