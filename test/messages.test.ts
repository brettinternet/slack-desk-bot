import { describe, expect, test } from "bun:test";
import {
  conversationId,
  isSupportedDirectMessage,
  splitSlackMessage,
  stripBotMention,
} from "../src/messages.ts";

describe("Slack message helpers", () => {
  test("removes only the bot mention", () => {
    expect(stripBotMention("<@BOT> please ask <@HUMAN>", "BOT")).toBe("please ask <@HUMAN>");
  });

  test("accepts plain and file-share DMs but ignores system subtypes", () => {
    expect(isSupportedDirectMessage()).toBe(true);
    expect(isSupportedDirectMessage("file_share")).toBe(true);
    expect(isSupportedDirectMessage("bot_message")).toBe(false);
    expect(isSupportedDirectMessage("message_changed")).toBe(false);
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

  test("provides a visible response for empty agent output", () => {
    expect(splitSlackMessage("  ")).toEqual(["Completed without a text response."]);
  });
});
