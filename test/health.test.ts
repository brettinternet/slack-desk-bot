import { describe, expect, test } from "bun:test";
import { startHealthServer } from "../src/health.ts";

describe("health server", () => {
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
