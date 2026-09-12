import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

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
      agentMode: "read-only",
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
      sessionDir: undefined,
      maxActiveSessions: 32,
      sessionIdleMs: 3_600_000,
    });
  });

  test("loads authorization, mode, session, and resource limits", () => {
    const config = loadConfig({
      ...valid,
      SLACK_ALLOWED_USER_IDS: " U0123, U0123, U0789 ",
      SLACK_AGENT_MODE: "read-write",
      SLACK_AGENT_SESSION_DIR: "/tmp/slack-agent-sessions",
      SLACK_AGENT_MAX_ACTIVE_SESSIONS: "8",
      SLACK_AGENT_SESSION_IDLE_MS: "300000",
      SLACK_AGENT_TIMEOUT_MS: "100",
      SLACK_AGENT_MAX_CONCURRENT_CONVERSATIONS: "7",
      SLACK_AGENT_RATE_LIMIT_BURST: "4",
    });

    expect(config.allowedUserIds).toEqual(new Set(["U0123", "U0789"]));
    expect(config.agentMode).toBe("read-write");
    expect(config).toMatchObject({
      sessionDir: "/tmp/slack-agent-sessions",
      maxActiveSessions: 8,
      sessionIdleMs: 300_000,
      queueLimits: {
        timeoutMs: 100,
        maxConcurrentConversations: 7,
        rateLimitBurst: 4,
      },
    });
  });

  test("rejects missing settings, invalid modes, paths, and limits", () => {
    expect(() => loadConfig({ ...valid, SLACK_BOT_TOKEN: "" })).toThrow("SLACK_BOT_TOKEN");
    expect(() => loadConfig({ ...valid, SLACK_ALLOWED_USER_IDS: "" })).toThrow(
      "SLACK_ALLOWED_USER_IDS",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_MODE: "write" })).toThrow("SLACK_AGENT_MODE");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_CWD: "." })).toThrow("absolute path");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_SESSION_DIR: ".sessions" })).toThrow(
      "SLACK_AGENT_SESSION_DIR",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_MAX_ACTIVE_SESSIONS: "0" })).toThrow(
      "positive integer",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_TIMEOUT_MS: "0" })).toThrow(
      "SLACK_AGENT_TIMEOUT_MS must be a positive integer",
    );
  });
});
