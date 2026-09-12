import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const valid = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_AGENT_CWD: process.cwd(),
};

describe("loadConfig", () => {
  test("loads required settings and limit defaults", () => {
    expect(loadConfig(valid)).toEqual({
      slackBotToken: "xoxb-test",
      slackAppToken: "xapp-test",
      workspace: process.cwd(),
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

  test("loads configured limits", () => {
    expect(
      loadConfig({
        ...valid,
        SLACK_AGENT_TIMEOUT_MS: "100",
        SLACK_AGENT_MAX_CONCURRENT_CONVERSATIONS: "7",
        SLACK_AGENT_RATE_LIMIT_BURST: "4",
      }),
    ).toMatchObject({
      queueLimits: {
        timeoutMs: 100,
        maxConcurrentConversations: 7,
        rateLimitBurst: 4,
      },
    });
  });

  test("rejects missing tokens, relative workspaces, and invalid limits", () => {
    expect(() => loadConfig({ ...valid, SLACK_BOT_TOKEN: "" })).toThrow("SLACK_BOT_TOKEN");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_CWD: "." })).toThrow("absolute path");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_TIMEOUT_MS: "0" })).toThrow(
      "SLACK_AGENT_TIMEOUT_MS must be a positive integer",
    );
  });
});
