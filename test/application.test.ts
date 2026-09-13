import { describe, expect, mock, test } from "bun:test";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueSnapshot } from "../src/agent.ts";
import { startApplication } from "../src/application.ts";
import type { Config } from "../src/config.ts";
import { SlackAuthenticationError } from "../src/slack.ts";

const queue: QueueSnapshot = {
  active: 0,
  queued: 0,
  limits: { max_concurrent: 3, max_queued: 20 },
  saturated: false,
  backend_available: true,
};

function config(): Config {
  return {
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    workspace: process.cwd(),
    allowedUserIds: new Set(["U_TEST"]),
    operatorUserIds: new Set(),
    agentMode: "read-only",
    instructions: undefined,
    queueLimits: {
      timeoutMs: 300_000,
      queueWaitMs: 600_000,
      maxQueuedPerConversation: 2,
      maxConcurrentConversations: 3,
      maxGlobalQueue: 20,
      maxPendingPerRequester: 3,
      rateLimitBurst: 3,
      rateLimitRefillMs: 60_000,
    },
    configuredMaxConcurrentConversations: 3,
    sessionDir: undefined,
    maxActiveSessions: 32,
    sessionIdleMs: 3_600_000,
    healthPort: 0,
    socketPath: join(tmpdir(), `slack-desk-application-${process.pid}`, "control.sock"),
  };
}

function backend() {
  return {
    run: mock(async () => "response"),
    handleCommand: mock(async () => "done"),
    cancelActive: mock(() => false),
    snapshot: mock(() => queue),
    dispose: mock(() => {}),
  };
}

describe("application startup", () => {
  test("assembles startup, reports readiness, and shuts down gracefully", async () => {
    const agent = backend();
    const slackStop = mock(async () => {});
    const application = await startApplication(config(), {
      piReady: async () => "Pi model test/model is available",
      createBackend: () => agent,
      createSlackAgent: ({ health }) => ({
        start: mock(async () => {
          health.setSlackConnection("connected");
          health.recordSuccessfulSlackOperation();
        }),
        stop: slackStop,
      }),
    });

    const response = await fetch(`http://127.0.0.1:${application.healthPort}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready" });

    await application.stop();
    await application.stop();
    expect(slackStop).toHaveBeenCalledTimes(1);
    expect(agent.dispose).toHaveBeenCalledTimes(1);
  });

  test("fails before creating runtime resources when Pi is not ready", async () => {
    const createBackend = mock(() => backend());
    const createSlackAgent = mock(() => ({ start: async () => {}, stop: async () => {} }));

    await expect(
      startApplication(config(), {
        piReady: async () => {
          throw new Error("No authenticated Pi model is available; run `pi` and /login");
        },
        createBackend,
        createSlackAgent,
      }),
    ).rejects.toThrow("No authenticated Pi model is available; run `pi` and /login");
    expect(createBackend).not.toHaveBeenCalled();
    expect(createSlackAgent).not.toHaveBeenCalled();
  });

  test("reports invalid Slack authentication without exposing credentials", async () => {
    const agent = backend();
    await expect(
      startApplication(config(), {
        piReady: async () => "Pi model test/model is available",
        createBackend: () => agent,
        createSlackAgent: () => ({
          start: async () => {
            throw new SlackAuthenticationError();
          },
          stop: async () => {},
        }),
      }),
    ).rejects.toThrow("verify SLACK_BOT_TOKEN");
    expect(agent.dispose).toHaveBeenCalledTimes(1);
  });

  test("reports an occupied health port before contacting Slack", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP port");

    const agent = backend();
    const slackStart = mock(async () => {});
    try {
      await expect(
        startApplication(
          { ...config(), healthPort: address.port },
          {
            piReady: async () => "Pi model test/model is available",
            createBackend: () => agent,
            createSlackAgent: () => ({ start: slackStart, stop: async () => {} }),
          },
        ),
      ).rejects.toThrow(`Health port ${address.port} is unavailable`);
      expect(slackStart).not.toHaveBeenCalled();
      expect(agent.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
