import { describe, expect, mock, test } from "bun:test";
import { createServer } from "node:net";
import type { AutomationService } from "../src/automations.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueSnapshot } from "../src/agent.ts";
import { scheduleStorePath, startApplication } from "../src/application.ts";
import type { Config } from "../src/config.ts";
import type { StructuredLog } from "../src/log.ts";
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
    agentBackend: "pi",
    agentMode: "read-only",
    agentCommandMode: "off",
    instructions: undefined,
    codexExecutable: undefined,
    codexHome: undefined,
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
    healthHost: "127.0.0.1",
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
  test("offers GitHub watches without Linear only when runtime lookup is configured", async () => {
    let seen: AutomationService | undefined;
    const setup = async (github?: Config["github"], githubReady = async () => "gh ready") =>
      startApplication(
        { ...config(), github },
        {
          piReady: async () => "Pi ready",
          githubReady,
          createBackend: () => backend(),
          createSlackAgent: ({ automations }) => {
            seen = automations;
            return { start: async () => {}, stop: async () => {} };
          },
          createLocalControl: () => ({ start: async () => {}, stop: async () => {} }),
        },
      );
    const off = await setup();
    expect(seen).toBeUndefined();
    await off.stop();
    const on = await setup({
      repos: ["work-org/project"],
    });
    expect(seen).toBeDefined();
    await expect(
      seen!.create(
        {
          source: { kind: "github-pr", id: "other/repo#42" },
          condition: { field: "merged", equals: "true" },
        },
        "U_TEST",
      ),
    ).rejects.toThrow("invalid source identifier");
    await on.stop();
    await expect(
      setup({ repos: ["work-org/project"] }, async () => {
        throw new Error("gh login is unavailable to the service");
      }),
    ).rejects.toThrow("gh login is unavailable to the service");
  });
  test("keeps Linux runtime sockets separate from persistent schedules", () => {
    const runtimeDir = "/run/user/1234";
    expect(
      scheduleStorePath(
        `${runtimeDir}/control.sock`,
        { XDG_RUNTIME_DIR: runtimeDir },
        "linux",
      ).startsWith(runtimeDir),
    ).toBe(false);
    expect(
      scheduleStorePath(
        "/var/lib/slack-desk/control.sock",
        { XDG_RUNTIME_DIR: runtimeDir },
        "linux",
      ),
    ).toBe("/var/lib/slack-desk/schedules.json");
  });
  test("assembles startup, reports readiness, and shuts down gracefully", async () => {
    const agent = backend();
    const slackStop = mock(async () => {});
    const records: StructuredLog[] = [];
    const application = await startApplication(config(), {
      log: (record) => records.push(record),
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

    expect(records).toEqual([
      {
        event: "startup",
        component: "application",
        outcome: "starting",
        backend: "pi",
        mode: "read-only",
        max_concurrent: 3,
        configured_max_concurrent: 3,
      },
    ]);

    const response = await fetch(`http://127.0.0.1:${application.healthPort}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready" });

    const shutdownStages: string[] = [];
    await application.stop((stage) => shutdownStages.push(stage));
    await application.stop();
    expect(shutdownStages).toEqual(["health_server", "local_control", "slack", "backend"]);
    expect(slackStop).toHaveBeenCalledTimes(1);
    expect(agent.dispose).toHaveBeenCalledTimes(1);
  });

  test("wires the local people lookup and shares a concurrent directory load", async () => {
    const loadUsers = mock(async () => [
      { id: "U0BOB", name: "Bob", handle: "bob", email: "bob@work.test" },
    ]);
    let lookup: ((query: string) => Promise<unknown>) | undefined;
    const application = await startApplication(config(), {
      piReady: async () => "Pi ready",
      createBackend: () => backend(),
      createSlackAgent: () => ({ start: async () => {}, stop: async () => {} }),
      createLocalControl: ({ findPeople }) => {
        lookup = findPeople;
        return { start: async () => {}, stop: async () => {} };
      },
      loadUsers,
    });
    try {
      expect(lookup).toBeDefined();
      const [email, name] = await Promise.all([lookup!("bob@work.test"), lookup!("Bob")]);
      expect(email).toEqual([{ userId: "U0BOB", name: "Bob", handle: "bob", match: "email" }]);
      expect(name).toEqual([{ userId: "U0BOB", name: "Bob", handle: "bob", match: "handle" }]);
      expect(loadUsers).toHaveBeenCalledTimes(1);
    } finally {
      await application.stop();
    }
  });

  test("reports the failing cleanup stage after finishing the remaining stages", async () => {
    const agent = backend();
    const slackStop = mock(async () => {});
    const application = await startApplication(config(), {
      piReady: async () => "Pi model test/model is available",
      createBackend: () => agent,
      createSlackAgent: () => ({ start: async () => {}, stop: slackStop }),
      createLocalControl: () => ({
        start: async () => {},
        stop: async () => {
          throw new Error("socket cleanup failed");
        },
      }),
    });

    const stages: string[] = [];
    await expect(application.stop((stage) => stages.push(stage))).rejects.toThrow(
      "socket cleanup failed",
    );
    expect(stages).toEqual(["health_server", "local_control", "slack", "backend", "local_control"]);
    expect(slackStop).toHaveBeenCalledTimes(1);
    expect(agent.dispose).toHaveBeenCalledTimes(1);
  });

  test("uses Codex readiness without checking Pi", async () => {
    const createBackend = mock(() => backend());
    const piReady = mock(async () => "Pi ready");
    const codexReady = mock(async () => "Codex ready");
    const application = await startApplication(
      { ...config(), agentBackend: "codex" },
      {
        piReady,
        codexReady,
        createBackend,
        createSlackAgent: () => ({ start: async () => {}, stop: async () => {} }),
      },
    );

    expect(codexReady).toHaveBeenCalledTimes(1);
    expect(piReady).not.toHaveBeenCalled();
    expect(createBackend).toHaveBeenCalledTimes(1);
    await application.stop();
  });

  test("uses Claude readiness without checking Pi or Codex", async () => {
    const createBackend = mock(() => backend());
    const piReady = mock(async () => "Pi ready");
    const codexReady = mock(async () => "Codex ready");
    const claudeReady = mock(async () => "Claude ready");
    const application = await startApplication(
      { ...config(), agentBackend: "claude" },
      {
        piReady,
        codexReady,
        claudeReady,
        createBackend,
        createSlackAgent: () => ({ start: async () => {}, stop: async () => {} }),
      },
    );

    expect(claudeReady).toHaveBeenCalledTimes(1);
    expect(piReady).not.toHaveBeenCalled();
    expect(codexReady).not.toHaveBeenCalled();
    await application.stop();
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
