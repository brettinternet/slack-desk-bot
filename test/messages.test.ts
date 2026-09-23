import { describe, expect, test } from "bun:test";
import {
  awaitsThreadReply,
  channelThreadIntent,
  conversationId,
  escapeSlackText,
  formatSlackText,
  isSupportedChannelMessage,
  isSupportedDirectMessage,
  MAX_SLACK_RESPONSE_MESSAGES,
  parseSlackCommand,
  slackUserMentions,
  splitSlackMessage,
  stripBotMention,
  threadReplyRecipient,
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
    expect(parseSlackCommand(" !STATUS ")).toEqual({ kind: "agent", command: "status" });
    expect(parseSlackCommand("  !HeLp\n")).toEqual({ kind: "help" });
    expect(parseSlackCommand("cancel")).toEqual({ kind: "agent", command: "cancel" });
  });

  test("classifies unsupported bang commands without affecting ordinary prompts", () => {
    expect(parseSlackCommand("!stats")).toEqual({ kind: "unknown" });
    expect(parseSlackCommand("!reset please")).toEqual({ kind: "unknown" });
    expect(parseSlackCommand("please! reset")).toBeUndefined();
    expect(parseSlackCommand("What?!")).toBeUndefined();
    expect(parseSlackCommand("reset")).toBeUndefined();
  });

  test("maps channel threads and DMs to stable conversations", () => {
    expect(conversationId("C123", "100.1")).toBe("C123:100.1");
    expect(conversationId("D123")).toBe("dm:D123");
  });

  test("recognizes channel-thread requests without requiring another mention", () => {
    expect(channelThreadIntent("Could you check staging?", "U_BOT", false)).toEqual({
      prompt: "Could you check staging?",
      respond: true,
    });
    expect(channelThreadIntent("laptop: main", "U_BOT", false)).toEqual({
      prompt: "main",
      respond: true,
    });
    expect(channelThreadIntent("<@U_BOT> main", "U_BOT", false)).toEqual({
      prompt: "main",
      respond: true,
    });
  });

  test("ignores acknowledgements, observations, and messages addressed to people", () => {
    expect(channelThreadIntent("Thanks!", "U_BOT", false).respond).toBe(false);
    expect(channelThreadIntent("thanks brett", "U_BOT", true).respond).toBe(false);
    expect(channelThreadIntent("ok main", "U_BOT", true).respond).toBe(true);
    expect(channelThreadIntent("sounds good, proceed", "U_BOT", true).respond).toBe(true);
    expect(channelThreadIntent("thanks <@U_BRETT>", "U_BOT", true).respond).toBe(false);
    expect(channelThreadIntent("What time works for you?", "U_BOT", false).respond).toBe(false);
    expect(channelThreadIntent("FYI, production is healthy.", "U_BOT", false).respond).toBe(false);
    expect(
      channelThreadIntent("No reply needed; production is healthy.", "U_BOT", true).respond,
    ).toBe(false);
    expect(channelThreadIntent("<@U_JANE> can you check this?", "U_BOT", true).respond).toBe(false);
  });

  test("accepts terse answers only while the bot is awaiting a reply", () => {
    expect(channelThreadIntent("the second one", "U_BOT", false).respond).toBe(false);
    expect(channelThreadIntent("the second one", "U_BOT", true).respond).toBe(true);
    expect(awaitsThreadReply("I found two options. Which one should I use?")).toBe(true);
    expect(awaitsThreadReply("Production is healthy.")).toBe(false);
    expect(threadReplyRecipient("I sent <@U_CFB> a reminder. What time works?", "U_BRETT")).toBe(
      "U_BRETT",
    );
    expect(threadReplyRecipient("<@U_CFB>, what time works?", "U_BRETT")).toBe("U_CFB");
    expect(threadReplyRecipient("Should I ping <@U_CFB>?", "U_BRETT")).toBe("U_BRETT");
    expect(threadReplyRecipient("Done. <@U_CFB>, what time works?", "U_BRETT")).toBe("U_CFB");
  });

  test("preserves only user mentions explicitly included in the request", () => {
    const allowed = slackUserMentions("ask <@U04ET2XUC3B> about this");

    expect(escapeSlackText("<@U04ET2XUC3B> hi <@U999> & <!channel>", allowed)).toBe(
      "<@U04ET2XUC3B> hi &lt;@U999&gt; &amp; &lt;!channel&gt;",
    );
  });

  test("formats Markdown bold as Slack mrkdwn without changing code", () => {
    const markdown = `Short answer: **Amp is better**; __Pi is flexible__.\n\n\`**literal**\`\n\n\`\`\`md\n**also literal**\n\`\`\``;

    expect(formatSlackText(markdown)).toBe(
      `Short answer: *Amp is better*; *Pi is flexible*.\n\n\`**literal**\`\n\n\`\`\`md\n**also literal**\n\`\`\``,
    );
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
