import { describe, expect, test } from "bun:test";
import {
  conversationId,
  isSupportedChannelMessage,
  isSupportedDirectMessage,
  MAX_SLACK_RESPONSE_MESSAGES,
  parseAgentCommand,
  parseSlackCommand,
  splitSlackMessage,
  stripBotMention,
  TRUNCATION_MARKER,
} from "../src/messages.ts";

describe("Slack message helpers", () => {
  test("removes only the bot mention", () => {
    expect(stripBotMention("<@BOT> please ask <@HUMAN>", "BOT")).toBe("please ask <@HUMAN>");
  });

  test("accepts user-authored message subtypes but ignores system subtypes", () => {
    expect(isSupportedDirectMessage()).toBe(true);
    expect(isSupportedDirectMessage("file_share")).toBe(true);
    expect(isSupportedDirectMessage("thread_broadcast")).toBe(false);
    expect(isSupportedChannelMessage("thread_broadcast")).toBe(true);
    expect(isSupportedChannelMessage("bot_message")).toBe(false);
    expect(isSupportedChannelMessage("message_changed")).toBe(false);
  });

  test("recognizes commands case-insensitively with surrounding whitespace", () => {
    expect(parseAgentCommand(" !STATUS ")).toBe("status");
    expect(parseSlackCommand("  !HeLp\n")).toEqual({ kind: "help" });
    expect(parseSlackCommand("cancel")).toEqual({ kind: "agent", command: "cancel" });
  });

  test("classifies unsupported bang commands without affecting ordinary prompts", () => {
    expect(parseSlackCommand("!stats")).toEqual({ kind: "unknown" });
    expect(parseSlackCommand("!reset please")).toEqual({ kind: "unknown" });
    expect(parseSlackCommand("please! reset")).toBeUndefined();
    expect(parseSlackCommand("What?!")).toBeUndefined();
    expect(parseAgentCommand("reset")).toBeUndefined();
  });

  test("maps channel threads and DMs to stable conversations", () => {
    expect(conversationId("C123", "100.1")).toBe("C123:100.1");
    expect(conversationId("D123")).toBe("dm:D123");
  });

  test("splits long output without dropping text", () => {
    const chunks = splitSlackMessage("alpha beta gamma delta", 12);
    expect(chunks).toEqual(["alpha beta", "gamma delta"]);
    expect(chunks.join(" ")).toBe("alpha beta gamma delta");
  });

  test("bounds total output and marks truncation", () => {
    const chunks = splitSlackMessage("word ".repeat(100), 100, 3);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks[2]).toEndWith(TRUNCATION_MARKER);
  });

  test("does not mark output within the total message limit", () => {
    const chunks = splitSlackMessage("word ".repeat(100), 200, MAX_SLACK_RESPONSE_MESSAGES);

    expect(chunks).toHaveLength(MAX_SLACK_RESPONSE_MESSAGES);
    expect(chunks.join(" ")).not.toContain("Output truncated");
  });

  test("provides a visible response for empty agent output", () => {
    expect(splitSlackMessage("  ")).toEqual(["Completed without a text response."]);
  });
});
