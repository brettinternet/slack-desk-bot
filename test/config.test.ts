import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const valid = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_AGENT_CWD: process.cwd(),
  SLACK_ALLOWED_USER_IDS: "U0123,U0456",
};

describe("loadConfig", () => {
  test("loads required settings and limit defaults", () => {
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
      sessionIdleMs: 3_600_000,
    });
  });

  test("loads authorization, mode, and resource limits", () => {
    const config = loadConfig({
      ...valid,
      SLACK_ALLOWED_USER_IDS: " U0123, U0123, U0789 ",
      SLACK_AGENT_MODE: "read-write",
      SLACK_AGENT_TIMEOUT_MS: "100",
      SLACK_AGENT_MAX_CONCURRENT_CONVERSATIONS: "7",
      SLACK_AGENT_RATE_LIMIT_BURST: "4",
    });

    expect(config.allowedUserIds).toEqual(new Set(["U0123", "U0789"]));
    expect(config.agentMode).toBe("read-write");
    expect(config.queueLimits).toMatchObject({
      timeoutMs: 100,
      maxConcurrentConversations: 7,
      rateLimitBurst: 4,
    });
  });

  test("rejects missing settings, invalid modes, paths, and limits", () => {
    expect(() => loadConfig({ ...valid, SLACK_BOT_TOKEN: "" })).toThrow("SLACK_BOT_TOKEN");
    expect(() => loadConfig({ ...valid, SLACK_ALLOWED_USER_IDS: "" })).toThrow(
      "SLACK_ALLOWED_USER_IDS",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_MODE: "write" })).toThrow("SLACK_AGENT_MODE");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_CWD: "." })).toThrow("absolute path");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_TIMEOUT_MS: "0" })).toThrow(
      "SLACK_AGENT_TIMEOUT_MS must be a positive integer",
    );
  });
});
