import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
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
      instructions: undefined,
    });
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

  test("rejects missing tokens and relative workspaces", () => {
    expect(() => loadConfig({ ...valid, SLACK_BOT_TOKEN: "" })).toThrow("SLACK_BOT_TOKEN");
    expect(() => loadConfig({ ...valid, SLACK_AGENT_CWD: "." })).toThrow("absolute path");
  });
});
