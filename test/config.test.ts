import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const valid = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_AGENT_CWD: process.cwd(),
};

describe("loadConfig", () => {
  test("loads required settings", () => {
    expect(loadConfig(valid)).toEqual({
      slackBotToken: "xoxb-test",
      slackAppToken: "xapp-test",
      workspace: process.cwd(),
      sessionDir: undefined,
      maxActiveSessions: 32,
      sessionIdleMs: 1_800_000,
    });
  });

  test("loads session limits", () => {
    expect(
      loadConfig({
        ...valid,
        SLACK_AGENT_SESSION_DIR: "/tmp/slack-agent-sessions",
        SLACK_AGENT_MAX_ACTIVE_SESSIONS: "8",
        SLACK_AGENT_SESSION_IDLE_MINUTES: "5",
      }),
    ).toMatchObject({
      sessionDir: "/tmp/slack-agent-sessions",
      maxActiveSessions: 8,
      sessionIdleMs: 300_000,
    });
  });

  test("rejects invalid paths and limits", () => {
    expect(() => loadConfig({ ...valid, SLACK_BOT_TOKEN: "" })).toThrow("SLACK_BOT_TOKEN");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_CWD: "." })).toThrow("absolute path");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_SESSION_DIR: ".sessions" })).toThrow(
      "SLACK_AGENT_SESSION_DIR",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_MAX_ACTIVE_SESSIONS: "0" })).toThrow(
      "positive integer",
    );
  });
});
