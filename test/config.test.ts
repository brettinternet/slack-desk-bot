import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const valid = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_AGENT_CWD: process.cwd(),
  SLACK_ALLOWED_USER_IDS: "U0123,U0456",
};

describe("loadConfig", () => {
  test("loads required settings", () => {
    expect(loadConfig(valid)).toEqual({
      slackBotToken: "xoxb-test",
      slackAppToken: "xapp-test",
      workspace: process.cwd(),
      allowedUserIds: new Set(["U0123", "U0456"]),
      agentMode: "read-only",
    });
  });

  test("loads explicit read-write mode and normalizes user IDs", () => {
    const config = loadConfig({
      ...valid,
      SLACK_ALLOWED_USER_IDS: " U0123, U0123, U0789 ",
      SLACK_AGENT_MODE: "read-write",
    });

    expect(config.allowedUserIds).toEqual(new Set(["U0123", "U0789"]));
    expect(config.agentMode).toBe("read-write");
  });

  test("rejects missing required settings and invalid modes", () => {
    expect(() => loadConfig({ ...valid, SLACK_BOT_TOKEN: "" })).toThrow("SLACK_BOT_TOKEN");
    expect(() => loadConfig({ ...valid, SLACK_ALLOWED_USER_IDS: "" })).toThrow(
      "SLACK_ALLOWED_USER_IDS",
    );
    expect(() => loadConfig({ ...valid, SLACK_AGENT_MODE: "write" })).toThrow("SLACK_AGENT_MODE");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_CWD: "." })).toThrow("absolute path");
  });
});
