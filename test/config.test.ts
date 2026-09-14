import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type AgentBackend, QueuedAgentBackend } from "../src/agent.ts";
import { defaultSocketPath, loadConfig, type AgentMode } from "../src/config.ts";

const valid = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_AGENT_CWD: process.cwd(),
  SLACK_ALLOWED_USER_IDS: "U0123,U0456",
};

describe("loadConfig", () => {
  test("loads required settings and defaults", () => {
    expect(loadConfig(valid)).toEqual({
      slackBotToken: "xoxb-test",
      slackAppToken: "xapp-test",
      workspace: process.cwd(),
      allowedUserIds: new Set(["U0123", "U0456"]),
      operatorUserIds: new Set(),
      agentBackend: "pi",
      agentMode: "read-only",
      agentCommandMode: "off",
      instructions: undefined,
      codexExecutable: undefined,
      codexHome: undefined,
      claudeExecutable: undefined,
      claudeHome: undefined,
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
      healthPort: 3_210,
      socketPath: defaultSocketPath(valid),
    });
  });

  test("loads backend, authorization, mode, session, and resource limits", () => {
    const config = loadConfig({
      ...valid,
      SLACK_ALLOWED_USER_IDS: " U0123, U0123, U0789 ",
      SLACK_OPERATOR_USER_IDS: " U0789, U0789 ",
      SLACK_AGENT_BACKEND: "pi",
      SLACK_AGENT_MODE: "read-write",
      SLACK_AGENT_COMMAND_MODE: "brokered",
      SLACK_AGENT_SESSION_DIR: "/tmp/slack-agent-sessions",
      SLACK_AGENT_MAX_ACTIVE_SESSIONS: "8",
      SLACK_AGENT_SESSION_IDLE_MS: "300000",
      SLACK_AGENT_TIMEOUT_MS: "100",
      SLACK_AGENT_MAX_CONCURRENT_CONVERSATIONS: "7",
      SLACK_AGENT_RATE_LIMIT_BURST: "4",
      SLACK_AGENT_HEALTH_PORT: "4321",
      SLACK_AGENT_SOCKET_PATH: "/tmp/slack-desk-control.sock",
    });

    expect(config.allowedUserIds).toEqual(new Set(["U0123", "U0789"]));
    expect(config.operatorUserIds).toEqual(new Set(["U0789"]));
    expect(config.agentBackend).toBe("pi");
    expect(config.agentMode).toBe("read-write");
    expect(config.agentCommandMode).toBe("brokered");
    expect(config).toMatchObject({
      sessionDir: "/tmp/slack-agent-sessions",
      maxActiveSessions: 8,
      sessionIdleMs: 300_000,
      healthPort: 4_321,
      socketPath: "/tmp/slack-desk-control.sock",
      configuredMaxConcurrentConversations: 7,
      queueLimits: {
        timeoutMs: 100,
        maxConcurrentConversations: 1,
        rateLimitBurst: 4,
      },
    });
  });

  test("loads Claude-specific settings and permits read-write mode", () => {
    const config = loadConfig({
      ...valid,
      SLACK_AGENT_BACKEND: "claude",
      SLACK_AGENT_MODE: "read-write",
      SLACK_CLAUDE_EXECUTABLE: "/usr/local/bin/claude",
      SLACK_CLAUDE_HOME: "/tmp/slack-desk-claude",
    });

    expect(config.agentBackend).toBe("claude");
    expect(config.agentMode).toBe("read-write");
    expect(config.claudeExecutable).toBe("/usr/local/bin/claude");
    expect(config.claudeHome).toBe("/tmp/slack-desk-claude");
  });

  test("loads Codex-specific settings", () => {
    const config = loadConfig({
      ...valid,
      SLACK_AGENT_BACKEND: "codex",
      SLACK_CODEX_EXECUTABLE: "/usr/local/bin/codex",
      SLACK_CODEX_HOME: "/tmp/slack-desk-codex",
    });

    expect(config.agentBackend).toBe("codex");
    expect(config.codexExecutable).toBe("/usr/local/bin/codex");
    expect(config.codexHome).toBe("/tmp/slack-desk-codex");
  });

  test("rejects operator IDs outside the allowlist", () => {
    expect(() => loadConfig({ ...valid, SLACK_OPERATOR_USER_IDS: "U_NOT_ALLOWED" })).toThrow(
      "SLACK_OPERATOR_USER_IDS must contain only allowed user IDs",
    );
  });

  test("retains configured conversation concurrency in read-only mode", () => {
    const config = loadConfig({
      ...valid,
      SLACK_AGENT_MODE: "read-only",
      SLACK_AGENT_MAX_CONCURRENT_CONVERSATIONS: "7",
    });

    expect(config.configuredMaxConcurrentConversations).toBe(7);
    expect(config.queueLimits.maxConcurrentConversations).toBe(7);
  });

  test("applies mode-specific concurrency to scheduling", async () => {
    for (const [mode, initiallyStarted] of [
      ["read-only", 2],
      ["read-write", 1],
    ] as const satisfies readonly [AgentMode, number][]) {
      const started: string[] = [];
      const releases: Array<() => void> = [];
      const backend: AgentBackend = {
        run: ({ conversationId }) =>
          new Promise((done) => {
            started.push(conversationId);
            releases.push(() => done(conversationId));
          }),
        dispose: () => {},
      };
      const config = loadConfig({
        ...valid,
        SLACK_AGENT_MODE: mode,
        SLACK_AGENT_MAX_CONCURRENT_CONVERSATIONS: "2",
      });
      const queued = new QueuedAgentBackend(backend, config.queueLimits);

      const first = queued.run({ conversationId: "one", requesterId: "one", prompt: "one" });
      const second = queued.run({ conversationId: "two", requesterId: "two", prompt: "two" });
      await Bun.sleep(0);
      expect(started).toHaveLength(initiallyStarted);

      releases[0]!();
      await first;
      await Bun.sleep(0);
      expect(started).toEqual(["one", "two"]);
      releases[1]!();
      await second;
      queued.dispose();
    }
  });

  test("loads inline Slack instructions", () => {
    expect(
      loadConfig({ ...valid, SLACK_AGENT_INSTRUCTIONS: "  Be concise and conversational.  " })
        .instructions,
    ).toBe("Be concise and conversational.");
  });

  test("loads Slack instructions from an absolute file path", () => {
    const instructionsFile = resolve(import.meta.dirname, "fixtures/slack-instructions.md");
    expect(
      loadConfig({ ...valid, SLACK_AGENT_INSTRUCTIONS_FILE: instructionsFile }).instructions,
    ).toBe("Keep Slack replies brief.");
  });

  test("rejects ambiguous or relative instruction configuration", () => {
    expect(() =>
      loadConfig({
        ...valid,
        SLACK_AGENT_INSTRUCTIONS: "Be concise.",
        SLACK_AGENT_INSTRUCTIONS_FILE: "/tmp/instructions.md",
      }),
    ).toThrow("Set only one");
    expect(() =>
      loadConfig({ ...valid, SLACK_AGENT_INSTRUCTIONS_FILE: "instructions.md" }),
    ).toThrow("must be an absolute path");
  });

  test("rejects missing settings, invalid modes, paths, and limits", () => {
    expect(() => loadConfig({ ...valid, SLACK_BOT_TOKEN: "" })).toThrow("SLACK_BOT_TOKEN");
    expect(() => loadConfig({ ...valid, SLACK_ALLOWED_USER_IDS: "" })).toThrow(
      "SLACK_ALLOWED_USER_IDS",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_BACKEND: "other" })).toThrow(
      "SLACK_AGENT_BACKEND",
    );
    expect(() => loadConfig({ ...valid, SLACK_CLAUDE_HOME: ".claude" })).toThrow(
      "SLACK_CLAUDE_HOME",
    );
    expect(() => loadConfig({ ...valid, SLACK_CLAUDE_EXECUTABLE: "claude" })).toThrow(
      "SLACK_CLAUDE_EXECUTABLE",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_MODE: "write" })).toThrow("SLACK_AGENT_MODE");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_COMMAND_MODE: "shell" })).toThrow(
      "SLACK_AGENT_COMMAND_MODE",
    );
    expect(() =>
      loadConfig({
        ...valid,
        SLACK_AGENT_BACKEND: "claude",
        SLACK_AGENT_COMMAND_MODE: "brokered",
      }),
    ).toThrow("currently requires SLACK_AGENT_BACKEND=pi");
    expect(() =>
      loadConfig({ ...valid, SLACK_AGENT_BACKEND: "codex", SLACK_AGENT_MODE: "read-write" }),
    ).toThrow("supports only");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_CWD: "." })).toThrow("absolute path");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_SESSION_DIR: ".sessions" })).toThrow(
      "SLACK_AGENT_SESSION_DIR",
    );
    expect(() => loadConfig({ ...valid, SLACK_CODEX_HOME: ".codex" })).toThrow("SLACK_CODEX_HOME");
    expect(() => loadConfig({ ...valid, SLACK_CODEX_EXECUTABLE: "codex" })).toThrow(
      "SLACK_CODEX_EXECUTABLE",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_SOCKET_PATH: "control.sock" })).toThrow(
      "SLACK_AGENT_SOCKET_PATH",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_MAX_ACTIVE_SESSIONS: "0" })).toThrow(
      "positive integer",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_TIMEOUT_MS: "0" })).toThrow(
      "SLACK_AGENT_TIMEOUT_MS must be a positive integer",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_HEALTH_PORT: "0" })).toThrow(
      "SLACK_AGENT_HEALTH_PORT must be a positive integer",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_HEALTH_PORT: "65536" })).toThrow(
      "SLACK_AGENT_HEALTH_PORT must be a valid TCP port",
    );
  });
});
